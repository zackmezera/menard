/**
 * Plans the split of a combined note into a pair, and verifies the plan
 * reconstructs the original. Pure. Owner: jobs module. DESIGN.md §7.3.
 */
import { parseNote, textUnits } from "../text/blocks";
import { lineStarts } from "../text/edits";
import type { Block, ParseOptions } from "../types";

export interface SplitPlan {
	/** Source note text after removing the translation region and its boundary heading. */
	sourceText: string;
	/** Translation note body (no frontmatter), footnote labels normalized. */
	translationBody: string;
	/** Footnote renames applied in the translation body, e.g. { "en-3": "3" }. */
	renamedFootnotes: Readonly<Record<string, string>>;
	/** Counts for the confirmation modal. */
	movedBlocks: number;
	/** Footnote definitions that leave the source for the translation. */
	movedFootnotes: number;
	/** Footnote definitions both halves cite: they stay in the source and a copy goes into the translation. */
	copiedFootnotes: number;
}

export type SplitResult = { ok: true; plan: SplitPlan } | { ok: false; reason: string };

/** A footnote reference or the label of a definition: `[^label]`. */
const FOOTNOTE_LABEL_RE = /\[\^([^\]\s]+)\]/g;
const PREFIXED_LABEL_RE = /^([A-Za-z]+)-(.+)$/;

/** A stretch of the original text that the split removes from the source. */
interface Piece {
	from: number;
	to: number;
}

/**
 * Finds the boundary heading by text at any level; the region runs to the
 * next heading of the same or higher level, or a skipped heading, or EOF.
 * Footnote definitions move with the region when only the region refers to
 * them, wherever they stand, and stay when only the source does; one that
 * both refer to stays and is copied into the translation, so neither note
 * is left with a reference to a missing definition.
 * Refuses when there is no boundary, no source text before it, no
 * translation text in it, or when label renames would collide. Verifies
 * that re-inserting the region reproduces the original exactly.
 */
export function planSplit(text: string, boundaryHeading: string, options: ParseOptions): SplitResult {
	const structure = parseNote(text, options);
	const { blocks, eol } = structure;
	const wanted = boundaryHeading.trim().toLowerCase();
	const boundary = wanted === "" ? -1 : blocks.findIndex((b) => b.kind === "heading" && b.body.trim().toLowerCase() === wanted);
	if (boundary < 0) return refuse(`This note has no “${boundaryHeading.trim()}” heading.`);

	const end = regionEnd(blocks, boundary, options.skipHeadings);
	const inRegion = (index: number): boolean => index > boundary && index < end;
	const regionRefs = new Set<string>();
	const outsideRefs = new Set<string>();
	blocks.forEach((block, index) => {
		if (block.kind === "footnote" || index === boundary) return;
		for (const match of block.raw.matchAll(FOOTNOTE_LABEL_RE)) (inRegion(index) ? regionRefs : outsideRefs).add(match[1] as string);
	});
	const moves = blocks.map((block, index) => {
		if (index === boundary) return true;
		if (block.kind !== "footnote") return inRegion(index);
		const label = block.footnoteLabel ?? "";
		return !outsideRefs.has(label) && (inRegion(index) || regionRefs.has(label));
	});
	const shared = (block: Block): boolean => block.kind === "footnote" && regionRefs.has(block.footnoteLabel ?? "") && outsideRefs.has(block.footnoteLabel ?? "");

	const moved = blocks.filter((_, index) => moves[index] && index !== boundary);
	const translated = blocks.flatMap((block, index) => (index !== boundary && (moves[index] || shared(block)) ? [index] : []));
	const ordered = [...translated.filter(inRegion), ...translated.filter((index) => !inRegion(index))].map((index) => blocks[index] as Block);
	const starts = lineStarts(text);
	const pieces = removedPieces(blocks, moves, starts, structure.frontmatter?.end ?? 0);
	const sourceText = cut(text, pieces);

	const sourceUnits = textUnits(parseNote(sourceText, options)).filter((block) => block.kind !== "heading");
	if (sourceUnits.length === 0) return refuse("There is no source text outside the translation section, so there is nothing to split.");
	if (!moved.some((block) => block.kind !== "verbatim" && block.kind !== "heading" && block.kind !== "menard")) {
		return refuse("There is no text under the translation heading.");
	}

	const translationLabels = ordered.flatMap((block) => (block.kind === "footnote" ? [block.footnoteLabel ?? ""] : []));
	const renames = footnoteRenames(
		translationLabels,
		blocks.flatMap((block, index) => (block.kind === "footnote" && !moves[index] ? [block.footnoteLabel ?? ""] : [])),
		[...regionRefs].filter((label) => !translationLabels.includes(label)),
	);
	if (renames === null) return refuse("Renaming the translation's footnotes would give two of them the same label.");

	const originalBody = ordered.map((block) => blockText(text, block, starts)).join(eol + eol) + eol;
	const translationBody = relabel(originalBody, renames);

	const inverse = Object.fromEntries(Object.entries(renames).map(([from, to]) => [to, from]));
	if (paste(sourceText, text, pieces) !== text || relabel(translationBody, inverse) !== originalBody) {
		return refuse("Menard could not verify that the split keeps every character of the note, so nothing was changed.");
	}
	return {
		ok: true,
		plan: {
			sourceText,
			translationBody,
			renamedFootnotes: renames,
			movedBlocks: moved.filter((block) => block.kind !== "footnote").length,
			movedFootnotes: moved.filter((block) => block.kind === "footnote").length,
			copiedFootnotes: ordered.filter(shared).length,
		},
	};
}

function refuse(reason: string): SplitResult {
	return { ok: false, reason };
}

/** Index of the first block after the region: a heading of the same or a higher level, a skipped heading, or the end. */
function regionEnd(blocks: readonly Block[], boundary: number, skipHeadings: readonly string[]): number {
	const level = blocks[boundary]?.headingLevel ?? 1;
	const skip = new Set(skipHeadings.map((heading) => heading.trim().toLowerCase()));
	for (let index = boundary + 1; index < blocks.length; index++) {
		const block = blocks[index] as Block;
		if (block.kind === "heading" && ((block.headingLevel ?? 1) <= level || skip.has(block.body.trim().toLowerCase()))) return index;
	}
	return blocks.length;
}

/**
 * One piece per run of consecutive moved blocks: from the run's first line
 * to the next kept block, so the blank lines after it go too. A run that
 * reaches the end of the note starts right after the last kept block
 * instead, so the source still ends with exactly one line ending.
 */
function removedPieces(blocks: readonly Block[], moves: readonly boolean[], starts: readonly number[], textStartLine: number): Piece[] {
	const pieces: Piece[] = [];
	const textLength = starts[starts.length - 1] ?? 0;
	for (let index = 0; index < blocks.length; index++) {
		if (!moves[index]) continue;
		const first = index;
		while (index + 1 < blocks.length && moves[index + 1]) index++;
		const next = blocks[index + 1];
		if (next !== undefined) {
			pieces.push({ from: starts[(blocks[first] as Block).lines.start] ?? 0, to: starts[next.lines.start] ?? textLength });
		} else {
			const previous = blocks[first - 1];
			const line = previous === undefined ? textStartLine : lastLine(previous) + 1;
			pieces.push({ from: starts[line] ?? textLength, to: textLength });
		}
	}
	return pieces;
}

function cut(text: string, pieces: readonly Piece[]): string {
	let out = "";
	let cursor = 0;
	for (const piece of pieces) {
		out += text.slice(cursor, piece.from);
		cursor = piece.to;
	}
	return out + text.slice(cursor);
}

/** Re-inserts the removed pieces of `original` into `reduced`. */
function paste(reduced: string, original: string, pieces: readonly Piece[]): string {
	let out = "";
	let cursor = 0;
	let shift = 0;
	for (const piece of pieces) {
		const at = piece.from - shift;
		out += reduced.slice(cursor, at) + original.slice(piece.from, piece.to);
		cursor = at;
		shift += piece.to - piece.from;
	}
	return out + reduced.slice(cursor);
}

function lastLine(block: Block): number {
	return Math.max(block.lines.end - 1, block.idLine ?? -1);
}

/** The block's lines exactly as written, including its id, without the final line ending. */
function blockText(text: string, block: Block, starts: readonly number[]): string {
	const from = starts[block.lines.start] ?? 0;
	let to = starts[lastLine(block) + 1] ?? text.length;
	if (to > from && text.charAt(to - 1) === "\n") to--;
	if (to > from && text.charAt(to - 1) === "\r") to--;
	return text.slice(from, to);
}

/**
 * Renames `en-3` to `3` when every moved label carries the same alphabetic
 * prefix and stripping it gives exactly the source's labels. Returns {} when
 * no rename applies, and null when the renaming is not a bijection: two
 * labels would merge, or a new label equals one the region already uses
 * for a note that stays in the source.
 */
function footnoteRenames(moved: readonly string[], source: readonly string[], otherRegionLabels: readonly string[]): Record<string, string> | null {
	const parsed = moved.map((label) => PREFIXED_LABEL_RE.exec(label));
	const prefix = parsed[0]?.[1];
	if (moved.length === 0 || prefix === undefined || !parsed.every((match) => match?.[1] === prefix)) return {};
	const stripped = parsed.map((match) => match?.[2] ?? "");
	const sourceSet = new Set(source);
	if (new Set(stripped).size !== sourceSet.size || !stripped.every((label) => sourceSet.has(label))) return {};
	if (new Set(stripped).size !== new Set(moved).size || stripped.some((label) => otherRegionLabels.includes(label))) return null;
	return Object.fromEntries(moved.map((label, index) => [label, stripped[index] as string]));
}

function relabel(text: string, renames: Readonly<Record<string, string>>): string {
	return text.replace(FOOTNOTE_LABEL_RE, (match, label: string) => {
		const renamed = renames[label];
		return renamed === undefined ? match : `[^${renamed}]`;
	});
}
