/**
 * Live Preview: hides Menard ids and Menard lines except where the
 * selection touches them. Owner: render module. DESIGN.md §9.6.
 */
import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { isMenardLine } from "../constants";
import type { MenardContext, PairIndex } from "../types";

/** A range to hide; `block` replaces whole lines (own-line ids, Menard lines). */
export interface HiddenRange {
	from: number;
	to: number;
	block: boolean;
}

const TRAILING_MENARD_ID_RE = /\s\^p\d+$/;
const OWN_LINE_MENARD_ID_RE = /^\^p\d+$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Pure: ranges to hide in `doc`, given selection ranges and toggles.
 * Trailing ` ^p<n>` ids and own-line `^p<n>` lines when hideIds; whole
 * `%%menard:1 …%%` lines when hideMaps; never inside fenced code; never on
 * a line a selection range touches; never a user's own id or comment.
 */
export function hiddenRanges(doc: string, selections: readonly { from: number; to: number }[], options: { hideIds: boolean; hideMaps: boolean }): HiddenRange[] {
	const hidden: HiddenRange[] = [];
	if (!options.hideIds && !options.hideMaps) return hidden;

	let fence: string | null = null;
	let inComment = false;
	let inFrontmatter = doc.startsWith("---\n") || doc.startsWith("---\r\n");
	let lineNumber = 0;
	for (let from = 0; from <= doc.length; lineNumber++) {
		const newline = doc.indexOf("\n", from);
		const next = newline === -1 ? doc.length + 1 : newline + 1;
		const raw = doc.slice(from, newline === -1 ? doc.length : newline);
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const to = from + line.length;
		const lineFrom = from;
		from = next;

		if (inFrontmatter) {
			if (lineNumber > 0 && /^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
			continue;
		}
		const fenceMatch = FENCE_RE.exec(line);
		if (fence !== null) {
			const marker = fenceMatch?.[1];
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
			continue;
		}
		const menardLine = isMenardLine(line);
		const togglesComment = !menardLine && (line.match(/%%/g)?.length ?? 0) % 2 === 1;
		// Inside a comment a fence is comment text; only the closing %% matters.
		if (inComment || togglesComment) {
			if (togglesComment) inComment = !inComment;
			continue;
		}
		if (fenceMatch?.[1]) {
			fence = fenceMatch[1];
			continue;
		}
		if (selections.some((sel) => sel.from <= to && sel.to >= lineFrom)) continue;

		if (menardLine) {
			if (options.hideMaps) hidden.push({ from: lineFrom, to, block: true });
		} else if (options.hideIds) {
			if (OWN_LINE_MENARD_ID_RE.test(line)) {
				hidden.push({ from: lineFrom, to, block: true });
			} else {
				const trailing = TRAILING_MENARD_ID_RE.exec(line);
				if (trailing) hidden.push({ from: lineFrom + trailing.index, to, block: false });
			}
		}
	}
	return hidden;
}

const inlineHide = Decoration.replace({});
const blockHide = Decoration.replace({ block: true });

/** A StateField of replace decorations, active only in Live Preview on pair notes. */
export function livePreviewExtension(ctx: MenardContext, pairs: PairIndex): Extension {
	const isActive = (state: EditorState): boolean => {
		if (!state.field(editorLivePreviewField, false)) return false;
		const file = state.field(editorInfoField, false)?.file;
		return !!file && pairs.mayBePair(file.path);
	};
	const compute = (state: EditorState): DecorationSet => {
		if (!isActive(state)) return Decoration.none;
		const settings = ctx.settings();
		const ranges = hiddenRanges(state.doc.toString(), state.selection.ranges, {
			hideIds: settings.hideBlockIds,
			hideMaps: settings.hideSentenceMaps,
		});
		const decorations: Range<Decoration>[] = ranges.map((r) => (r.block ? blockHide : inlineHide).range(r.from, r.to));
		return Decoration.set(decorations, true);
	};

	return StateField.define<DecorationSet>({
		create: compute,
		update(value, tr) {
			const modeChanged =
				tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false) ||
				tr.startState.field(editorInfoField, false) !== tr.state.field(editorInfoField, false);
			return tr.docChanged || tr.selection !== undefined || modeChanged ? compute(tr.state) : value;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}
