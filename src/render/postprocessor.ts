/**
 * The Markdown post-processor that marks units and wraps sentences in
 * reading view, for both notes of a pair. Never writes to the vault.
 * Owner: render module. DESIGN.md §9.1.
 */
import { MarkdownRenderChild, type MarkdownPostProcessor, type MarkdownPostProcessorContext } from "obsidian";
import { unitBlocks } from "../align/model";
import { ATTR, FM, MENARD_ID_RE, isMenardLine } from "../constants";
import type { MenardContext, PairIndex, SectionListener } from "../types";
import { unwrapAll, wrapUnit } from "./wrap";

/** On a processed section: the model version it was wrapped for. */
export const DONE_ATTR = "data-menard-done";

/** Containers whose renders are previews of a note, not the note's own view. */
const FOREIGN_CONTAINER = `[${ATTR.offscreen}], .hover-popover, .popover, .markdown-embed`;

/**
 * Returns the processor to register with sort order 100. For each section:
 * gate on pair frontmatter; skip when getSectionInfo is null or inside an
 * offscreen container; find the unit by line; mark Menard-line sections;
 * reconcile the map side against the DOM words; wrap; set unit attributes;
 * notify the listener. Idempotent per section and model version.
 *
 * Reading view renders a section again only when its own text changes, so
 * rendered sections are revisited when a pair's model is rebuilt and when
 * a note's frontmatter changes (a pair may just have formed). Reading view
 * also detaches off-screen sections and re-attaches the same elements
 * without rendering them again; a section detached at a rebuild is
 * revisited when it comes back, and every re-attached section is reported
 * to the listener so its session repaints it.
 */
export function createPostProcessor(ctx: MenardContext, pairs: PairIndex, listener: SectionListener): MarkdownPostProcessor {
	let reported = false;
	const lines = new LineIndex();
	/** Sections already given a render child, so a rewrap for a new version adds none. */
	const withChild = new WeakSet<HTMLElement>();
	/** Sections seen per reading-view container, kept while the container is in the document. */
	const views = new Map<HTMLElement, TrackedView>();
	/** Sections seen without a container; dropped once detached. */
	const loose = new Map<HTMLElement, MarkdownPostProcessorContext>();
	/** Sections currently detached by their view, awaiting re-attachment. */
	const detached = new WeakSet<HTMLElement>();

	ctx.owner.register(() => {
		for (const view of views.values()) view.observer?.disconnect();
		views.clear();
	});

	const watch = (container: HTMLElement): TrackedView => {
		const view: TrackedView = { path: null, sections: new Map(), observer: null };
		if (typeof MutationObserver !== "undefined") {
			view.observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of Array.from(record.removedNodes)) {
						if (node.instanceOf(HTMLElement) && view.sections.has(node)) detached.add(node);
					}
					for (const node of Array.from(record.addedNodes)) {
						if (!node.instanceOf(HTMLElement) || !detached.has(node)) continue;
						const pctx = view.sections.get(node);
						detached.delete(node);
						if (pctx) void run(node, pctx, false, true);
					}
				}
			});
			view.observer.observe(container, { childList: true, subtree: true });
		}
		views.set(container, view);
		return view;
	};

	const remember = (el: HTMLElement, pctx: MarkdownPostProcessorContext): void => {
		const container = containerOf(pctx);
		if (!container) {
			loose.set(el, pctx);
			return;
		}
		const view = views.get(container) ?? watch(container);
		if (view.path !== pctx.sourcePath) {
			// The view moved to another note: the old note's detached sections never come back.
			for (const old of [...view.sections.keys()]) if (!old.isConnected) view.sections.delete(old);
			view.path = pctx.sourcePath;
		}
		view.sections.set(el, pctx);
	};

	/** Drops sections that can no longer come back, such as those of closed views. */
	const forgetDetached = (): void => {
		for (const el of [...loose.keys()]) if (!el.isConnected) loose.delete(el);
		for (const [container, view] of [...views]) {
			if (container.isConnected) continue;
			view.observer?.disconnect();
			views.delete(container);
		}
	};

	/**
	 * Processes the note's attached sections again; `onlyUnmarked` limits it
	 * to sections never marked. Detached sections wait for re-attachment.
	 */
	const revisit = (path: string, onlyUnmarked: boolean): void => {
		const all = [...loose, ...[...views.values()].flatMap((view) => [...view.sections])];
		for (const [el, pctx] of all) {
			if (pctx.sourcePath !== path || !el.isConnected) continue;
			if (!onlyUnmarked || !el.hasAttribute(DONE_ATTR)) void run(el, pctx, false);
		}
	};

	ctx.owner.register(
		pairs.onChange((sourcePath) => {
			forgetDetached();
			const source = ctx.app.vault.getFileByPath(sourcePath);
			const target = source ? pairs.resolve(source)?.pair.target : undefined;
			revisit(sourcePath, false);
			if (target) revisit(target.path, false);
		}),
	);
	ctx.owner.registerEvent(
		ctx.app.metadataCache.on("changed", (file) => {
			forgetDetached();
			if (pairs.resolve(file)) revisit(file.path, true);
		}),
	);

	/** `reattached`: the view put back a section it had detached; report it even when up to date. */
	const process = async (el: HTMLElement, pctx: MarkdownPostProcessorContext, fresh: boolean, reattached: boolean): Promise<void> => {
		// On a revisit the context's frontmatter is as it was at render time; pairs.resolve below decides.
		const frontmatter = pctx.frontmatter as Record<string, unknown> | null | undefined;
		if (fresh && (!frontmatter || (frontmatter[FM.source] == null && frontmatter[FM.translation] == null))) return;

		const info = pctx.getSectionInfo(el);
		if (!info) return;
		if (el.closest(`[${ATTR.offscreen}]`) || containerOf(pctx)?.closest(FOREIGN_CONTAINER)) return;

		// Decided before the first await: Obsidian measures the section right after
		// rendering it, and a section collapsed later keeps its stale height.
		const sectionLines = lines.slice(info.text, info.lineStart, info.lineEnd).filter((line) => line.trim() !== "");
		const hidden = sectionLines.length > 0 && sectionLines.every((line) => isHiddenLine(line.trim()));
		if (hidden) el.setAttribute(ATTR.menardSection, "");

		const file = ctx.app.vault.getFileByPath(pctx.sourcePath);
		if (!file) return;
		const resolved = pairs.resolve(file);
		if (!resolved) return;
		const model = await pairs.load(file);
		if (!model) return;

		const version = String(model.version);
		if (el.getAttribute(DONE_ATTR) === version) {
			if (reattached && !el.hasAttribute(ATTR.menardSection)) listener.sectionRendered(file.path, el);
			return;
		}
		if (el.hasAttribute(DONE_ATTR)) clearMarks(el);

		if (hidden) {
			el.setAttribute(ATTR.menardSection, "");
			el.setAttribute(DONE_ATTR, version);
			return;
		}

		const { side } = resolved;
		const unit = model.unitAtLine(side, info.lineStart);
		// An own-line id renders as a section of its own; only the block's first section is the unit.
		// A merged unit (ADR 0010) has one such section per block, each tagged with the unit's key.
		const own = unit ? unitBlocks(unit, side).find((block) => info.lineStart >= block.lines.start && info.lineStart < block.lines.end) : undefined;
		const unitEl = el.firstElementChild;
		if (unit && own && unitEl?.instanceOf(HTMLElement)) {
			unitEl.setAttribute(ATTR.unit, unit.key);
			unitEl.setAttribute("lang", model.languages[side]);
			const fitted = wrapUnit(unitEl, unit, side, own);
			if (fitted) unitEl.setAttribute(ATTR.fit, fitted.status);
		}

		el.setAttribute(DONE_ATTR, version);
		if (!withChild.has(el)) {
			withChild.add(el);
			pctx.addChild(new MarkdownRenderChild(el));
		}
		listener.sectionRendered(file.path, el);
	};

	const run = async (el: HTMLElement, pctx: MarkdownPostProcessorContext, fresh: boolean, reattached = false): Promise<void> => {
		try {
			await process(el, pctx, fresh, reattached);
		} catch (error) {
			if (!reported) {
				reported = true;
				console.error("Menard:", error);
			}
		}
	};

	return (el, pctx) => {
		remember(el, pctx);
		return run(el, pctx, true);
	};
}

interface TrackedView {
	/** The note the view last rendered. */
	path: string | null;
	sections: Map<HTMLElement, MarkdownPostProcessorContext>;
	observer: MutationObserver | null;
}

function containerOf(pctx: MarkdownPostProcessorContext): HTMLElement | undefined {
	return (pctx as { containerEl?: HTMLElement }).containerEl;
}

/** Undoes an earlier pass over `el`: spans, unit marks and the Menard-line mark. */
function clearMarks(el: HTMLElement): void {
	unwrapAll(el);
	el.removeAttribute(ATTR.menardSection);
	for (const unitEl of Array.from(el.querySelectorAll(`[${ATTR.unit}]`))) {
		unitEl.removeAttribute(ATTR.unit);
		unitEl.removeAttribute(ATTR.fit);
		unitEl.removeAttribute("lang");
	}
}

/** Line starts of the last document seen; sections of one render share its text. */
class LineIndex {
	private text: string | null = null;
	private starts: number[] = [];

	/** Lines `from` to `to`, both inclusive, without their line endings. */
	slice(text: string, from: number, to: number): string[] {
		if (text !== this.text) {
			this.text = text;
			this.starts = [0];
			for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
		}
		const out: string[] = [];
		for (let line = from; line <= to && line < this.starts.length; line++) {
			const start = this.starts[line] ?? text.length;
			const next = this.starts[line + 1];
			out.push(text.slice(start, next === undefined ? text.length : next - 1).replace(/\r$/, ""));
		}
		return out;
	}
}

/** A Menard line, or a Menard id on its own line (after a quote or callout): neither shows any text. */
function isHiddenLine(line: string): boolean {
	return isMenardLine(line) || (line.startsWith("^") && MENARD_ID_RE.test(line.slice(1)));
}
