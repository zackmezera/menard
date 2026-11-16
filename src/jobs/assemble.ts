/**
 * Turns validated model output into the Markdown written to the
 * translation note, including the sentence map, and prepares source units
 * for the model. Pure. Owner: jobs module. DESIGN.md §7.1.
 */
import { linksFromRanges } from "../align/map";
import { wordsOf } from "../align/words";
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from "../constants";
import { protect, restore } from "../llm/protect";
import { projectMarkdown } from "../text/inline";
import { segmentSentences, sentenceMarkdown } from "../text/segment";
import type { Block, CharRange, MenardLine, Protected, SegmentRules, TranslateOutput, UnitKey, Word, WordRange } from "../types";

export interface SentenceUnitSource {
	key: UnitKey;
	block: Block;
	/** Source sentence ranges over the block's projection, as sent to the model. */
	sentences: readonly { start: number; end: number }[];
	tokens: Protected["tokens"];
}

/** A sentence unit cut into protected sentences, ready for a translate prompt. */
export interface PreparedUnit {
	/** Sentence ranges over the projection of `block.body`. */
	sentences: CharRange[];
	/** One protected Markdown slice per sentence, placeholders numbered across the unit. */
	protectedSentences: string[];
	tokens: Protected["tokens"];
}

const NUMBERED_PLACEHOLDER_RE = new RegExp(`^${PLACEHOLDER_OPEN}([A-Z])\\d+${PLACEHOLDER_CLOSE}$`);
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_OPEN}[^${PLACEHOLDER_OPEN}${PLACEHOLDER_CLOSE}\\n]*${PLACEHOLDER_CLOSE}`, "g");
const CALLOUT_HEADER_RE = /^(\s{0,3}>[ \t]*\[![^\]\s]+\][+-]?)/;
const FOOTNOTE_INDENT = "    ";

/**
 * Projects and segments a sentence unit, cuts its Markdown into one slice
 * per sentence, and protects each slice. Soft line breaks stay in paragraph
 * slices; quote and callout line breaks become placeholders. Throws
 * MenardError("reserved-character") when the text holds ⟦ or ⟧.
 */
export function prepareSentenceUnit(block: Block, rules: SegmentRules): PreparedUnit {
	const projection = projectMarkdown(block.body);
	const sentences = segmentSentences(projection, rules);
	const slices = sentenceMarkdown(block.body, projection, sentences);
	const { texts, tokens } = protectSlices(slices, block.kind === "paragraph" ? "keep" : "placeholder");
	return { sentences, protectedSentences: texts, tokens };
}

/**
 * Protects each slice on its own and renumbers the numbered placeholders
 * (⟦C1⟧, ⟦V1⟧, ⟦U1⟧) so that they are unique across the whole unit.
 */
export function protectSlices(slices: readonly string[], lineBreaks: "keep" | "placeholder"): { texts: string[]; tokens: Protected["tokens"] } {
	const tokens: { placeholder: string; original: string }[] = [];
	const issued = new Set<string>();
	const counters = new Map<string, number>();
	const texts = slices.map((slice) => {
		const result = protect(slice, { lineBreaks });
		const renames = new Map<string, string>();
		for (const token of result.tokens) {
			const kind = NUMBERED_PLACEHOLDER_RE.exec(token.placeholder)?.[1];
			let placeholder = token.placeholder;
			if (kind !== undefined) {
				const n = (counters.get(kind) ?? 0) + 1;
				counters.set(kind, n);
				placeholder = `${PLACEHOLDER_OPEN}${kind}${n}${PLACEHOLDER_CLOSE}`;
				renames.set(token.placeholder, placeholder);
			}
			if (!issued.has(placeholder)) {
				issued.add(placeholder);
				tokens.push({ placeholder, original: token.original });
			}
		}
		return result.text.replace(PLACEHOLDER_RE, (found) => renames.get(found) ?? found);
	});
	return { texts, tokens };
}

/**
 * Restores placeholders, joins groups with spaces (quote and callout lines
 * rebuilt with their `>` prefixes and the translated callout title), appends
 * the id, and computes the map from word counts of each group on both sides.
 * Returns the block text (with id) and the map line.
 */
export function assembleSentenceUnit(source: SentenceUnitSource, output: TranslateOutput, eol: string): { block: string; map: MenardLine } {
	const { block, key } = source;
	const sourceProjection = projectMarkdown(block.body);
	const starts: number[] = [];
	let body = "";
	let previous: number | undefined;
	for (const group of output.groups) {
		const piece = restore(group.markdown, source.tokens);
		if (body !== "" && !body.endsWith("\n") && !piece.startsWith("\n")) body += groupSeparator(block.body, sourceProjection.toInput, source.sentences, previous, group.src[0]);
		starts.push(body.length);
		body += piece;
		previous = group.src[group.src.length - 1] ?? previous;
	}

	const sourceWords = wordsOf(sourceProjection.text);
	const targetProjection = projectMarkdown(body);
	const targetWords = wordsOf(targetProjection.text);
	const sourceRanges: WordRange[] = [];
	const targetRanges: WordRange[] = [];
	let sourceCursor = 0;
	output.groups.forEach((group, index) => {
		const first = group.src[0];
		const last = group.src[group.src.length - 1];
		if (first === undefined || last === undefined) {
			sourceRanges.push({ start: sourceCursor, end: sourceCursor });
		} else {
			const range = wordRangeOf(sourceWords, source.sentences[first - 1]?.start ?? 0, source.sentences[last - 1]?.end ?? 0);
			sourceRanges.push(range);
			sourceCursor = range.end;
		}
		const from = wordIndexAtInput(targetWords, targetProjection.toInput, starts[index] ?? 0);
		const to = wordIndexAtInput(targetWords, targetProjection.toInput, starts[index + 1] ?? body.length + 1);
		targetRanges.push({ start: from, end: to });
	});

	// A translator's addition that holds no words has nothing to align.
	const keep = sourceRanges.map((range, i) => range.end > range.start || (targetRanges[i]?.end ?? 0) > (targetRanges[i]?.start ?? 0));
	const links = linksFromRanges(
		{ words: sourceWords, ranges: sourceRanges.filter((_, i) => keep[i]) },
		{ words: targetWords, ranges: targetRanges.filter((_, i) => keep[i]) },
		keep.filter(Boolean).map(() => false),
	);
	const total = (side: "src" | "tgt"): number => links.reduce((sum, link) => sum + (link[side]?.count ?? 0), 0);
	if (total("tgt") !== targetWords.length || total("src") !== sourceWords.length) {
		throw new Error(
			`Sentence map for ${key} does not cover the unit: ${total("src")} of ${sourceWords.length} source words, ${total("tgt")} of ${targetWords.length} target words`,
		);
	}
	return { block: withId(blockMarkdown(block, body, output.calloutTitle, eol), block, key, eol), map: { kind: "map", key, links } };
}

/** Lists and tables: restored Markdown plus own-line id. Footnotes: `[^label]: …` with continuation indent. */
export function assemblePlainUnit(key: UnitKey, block: Block, markdown: string, tokens: Protected["tokens"], eol: string): string {
	const lines = restore(markdown, tokens).split("\n");
	if (block.kind === "footnote") {
		const [first = "", ...rest] = lines;
		const continuation = rest.map((line) => (line.trim() === "" ? "" : FOOTNOTE_INDENT + line));
		return [`[^${block.footnoteLabel ?? key.replace(/^fn:/, "")}]: ${first}`, ...continuation].join(eol);
	}
	return withId(lines.join(eol), block, key, eol);
}

/**
 * What goes between two translated groups: the source's own line break when
 * the source breaks the line between those sentences (verse, hard-wrapped
 * lines), a space otherwise. Sentences are 1-based; offsets are projected.
 */
function groupSeparator(markdown: string, toInput: Int32Array, sentences: SentenceUnitSource["sentences"], before: number | undefined, after: number | undefined): string {
	if (before === undefined || after === undefined || after <= before) return " ";
	const from = sentences[before - 1]?.start;
	const start = sentences[after - 1]?.start;
	if (from === undefined || start === undefined) return " ";
	// A sentence range runs up to the next sentence, so the break sits in its trailing whitespace.
	const tail = /\\?\s*$/.exec(markdown.slice(toInput[from] ?? 0, toInput[start] ?? markdown.length))?.[0] ?? "";
	const lineBreak = /( {2,}|\\)?\r?\n/.exec(tail);
	return lineBreak ? lineBreak[0].replace(/\r/g, "") : " ";
}

/** Rules for a unit kind: paragraphs treat "\n" as a space, quotes and callouts as a boundary. */
export function rulesFor(block: Block, base: Omit<SegmentRules, "lineBreaks">): SegmentRules {
	return { ...base, lineBreaks: block.kind === "quote" || block.kind === "callout" ? "boundary" : "space" };
}

/** The words that start in [start, end) of a projection, as a word-index range. */
export function wordRangeOf(words: readonly Word[], start: number, end: number): WordRange {
	let from = 0;
	while (from < words.length && (words[from] as Word).start < start) from++;
	let to = from;
	while (to < words.length && (words[to] as Word).start < end) to++;
	return { start: from, end: to };
}

/** Index of the first word that comes from input offset `offset` or later. */
function wordIndexAtInput(words: readonly Word[], toInput: Int32Array, offset: number): number {
	let index = 0;
	while (index < words.length && (toInput[(words[index] as Word).start] ?? 0) < offset) index++;
	return index;
}

/** The block's lines for its kind: a paragraph as is, a quote or callout with `>` prefixes and header. */
function blockMarkdown(block: Block, body: string, calloutTitle: string | undefined, eol: string): string {
	if (block.kind === "paragraph") return body.split("\n").join(eol);
	const lines = body.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
	if (block.kind === "callout") {
		const header = CALLOUT_HEADER_RE.exec(block.raw)?.[1] ?? `> [!${block.calloutType ?? "note"}]`;
		const title = calloutTitle ?? "";
		lines.unshift(title === "" ? header : `${header} ${title}`);
	}
	return lines.join(eol);
}

/** Appends the id: trailing for a paragraph, on its own line after a blank line otherwise. */
function withId(markdown: string, block: Block, key: UnitKey, eol: string): string {
	return block.kind === "paragraph" ? `${markdown} ^${key}` : `${markdown}${eol}${eol}^${key}`;
}
