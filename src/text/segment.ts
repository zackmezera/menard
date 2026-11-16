/**
 * Sentence segmentation of a projection: Intl.Segmenter plus Menard's merge
 * and split passes. Used only when a map is written; the reader never
 * segments. Pure. Owner: text module. DESIGN.md §5.3.
 */
import type { CharRange, Projection, SegmentRules } from "../types";

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const HAS_WORD_RE = /[\p{L}\p{N}\p{M}]/u;
const SPACE_RE = /\s/;
/** Characters that may open a sentence before its first letter. */
const OPENERS = "([{«“‘\"'¿¡—–-";
/** Characters that close a sentence after its final punctuation. */
const CLOSERS = ")]}»”’›";
const TERMINALS = ".?!…";
/** A roman numeral as a whole word at the start of a sentence. */
const ROMAN_RE = /^[IVXLCDM]+(?![\p{L}\p{N}])/u;

const segmenters = new Map<string, Intl.Segmenter>();

/**
 * The cached segmenter for `lang`. A code written with "_" (`es_ES`, from a
 * hand-edited property) is read as BCP 47; one that is still not a valid tag
 * falls back to the default locale rather than failing the job.
 */
function segmenterFor(lang: string): Intl.Segmenter {
	let segmenter = segmenters.get(lang);
	if (segmenter === undefined) {
		try {
			segmenter = new Intl.Segmenter(lang.trim().replace(/_/g, "-"), { granularity: "sentence" });
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			segmenter = new Intl.Segmenter([], { granularity: "sentence" });
		}
		segmenters.set(lang, segmenter);
	}
	return segmenter;
}

/**
 * Returns sentence ranges over `projection.text`, in order, covering every
 * word. Whitespace between sentences belongs to the preceding sentence.
 */
export function segmentSentences(projection: Projection, rules: SegmentRules): CharRange[] {
	const text = projection.text;
	if (!HAS_WORD_RE.test(text)) return [];
	const flat = rules.lineBreaks === "space" ? text.replace(/\n/g, " ") : text;
	const chunks = rules.lineBreaks === "boundary" ? lineChunks(text) : [{ start: 0, end: text.length }];
	const ranges: CharRange[] = [];
	for (const chunk of chunks) {
		let pieces = mergeShort(flat, mergeBoundaries(flat, icuSegments(flat, chunk, rules.lang), rules));
		if (rules.splitDialogue) pieces = pieces.flatMap((range) => splitDialogue(flat, range));
		ranges.push(...pieces);
	}
	return finalize(text, absorbWordless(text, ranges));
}

/**
 * Cuts `markdown` (the input of `projection`) into one Markdown slice per
 * sentence. Each cut falls at the input offset of the next sentence's first
 * character, so atoms between sentences (a footnote ref after a period)
 * stay with the preceding sentence. Slices concatenate to `markdown`.
 *
 * A cut also moves back over Markdown that projects to nothing and sits
 * directly before the sentence (an opening `*`, `[[`, a link target before
 * `|`), stopping at the first visible character, so that a sentence never
 * starts in the middle of its own markup.
 */
export function sentenceMarkdown(markdown: string, projection: Projection, sentences: readonly CharRange[]): string[] {
	if (sentences.length === 0) return [];
	const visible = new Uint8Array(markdown.length + 1);
	for (const index of projection.toInput) visible[index] = 1;
	const cuts = [0];
	for (let k = 1; k < sentences.length; k++) {
		const previous = cuts[cuts.length - 1] ?? 0;
		let cut = Math.max(previous, projection.toInput[sentences[k]?.start ?? 0] ?? markdown.length);
		while (cut > previous && visible[cut - 1] === 0) cut--;
		cuts.push(cut);
	}
	cuts.push(markdown.length);
	return cuts.slice(1).map((end, k) => markdown.slice(cuts[k], end));
}

/** One chunk per line, each including its trailing "\n". */
function lineChunks(text: string): CharRange[] {
	const chunks: CharRange[] = [];
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		if (newline === -1) break;
		chunks.push({ start, end: newline + 1 });
		start = newline + 1;
	}
	if (start < text.length) chunks.push({ start, end: text.length });
	return chunks;
}

function icuSegments(flat: string, chunk: CharRange, lang: string): CharRange[] {
	const ranges: CharRange[] = [];
	for (const piece of segmenterFor(lang).segment(flat.slice(chunk.start, chunk.end))) {
		const start = chunk.start + piece.index;
		ranges.push({ start, end: start + piece.segment.length });
	}
	return ranges;
}

/** Step 2 of §5.3, boundary by boundary: abbreviations, initials, abbreviation plus digit, closers, lower case. */
function mergeBoundaries(flat: string, segments: readonly CharRange[], rules: SegmentRules): CharRange[] {
	const merged: CharRange[] = [];
	for (const segment of segments) {
		const last = merged[merged.length - 1];
		const stray = last === undefined ? segment.start : strayCloserEnd(flat, last, segment);
		if (last !== undefined && stray > segment.start) {
			last.end = stray;
			merged.push({ start: stray, end: segment.end });
		} else if (last !== undefined && joinsPrevious(flat.slice(last.start, last.end), flat.slice(segment.start, segment.end), rules)) {
			last.end = segment.end;
		} else {
			merged.push({ ...segment });
		}
	}
	return merged;
}

function joinsPrevious(before: string, after: string, rules: SegmentRules): boolean {
	const head = after.trimStart();
	if (head !== "" && CLOSERS.includes(head.charAt(0))) return true;
	const letter = firstLetter(head);
	if (letter !== null && /\p{Ll}/u.test(letter)) return true;
	const tail = before.trimEnd();
	if (!tail.endsWith(".")) return false;
	const token = lastToken(tail.slice(0, -1));
	// A lower-case single letter is a word ("la letra a.", "inciso b.") before a capitalized word, unless that is a roman numeral ("s. XIX", "t. II").
	if (/^\p{Ll}$/u.test(token) && /^\p{Lu}/u.test(letter ?? "") && !ROMAN_RE.test(head)) return false;
	if (rules.abbreviations.has(token.toLowerCase())) return true;
	if (/^\p{Lu}$/u.test(token)) return true;
	return /^\p{L}{1,4}$/u.test(token) && /^\p{N}/u.test(head);
}

/**
 * Where a segment that opens with a stray closer typed after a space
 * ("literature. ) To assume", an OCR or typing slip) really starts: after the
 * closers, when the previous segment ends a sentence and a capitalized word
 * follows. Otherwise `segment.start`, and the closer rule joins it.
 */
function strayCloserEnd(flat: string, previous: CharRange, segment: CharRange): number {
	let i = segment.start;
	while (i < segment.end && CLOSERS.includes(flat.charAt(i))) i++;
	if (i === segment.start || !SPACE_RE.test(flat.charAt(i))) return segment.start;
	if (!TERMINALS.includes(flat.slice(previous.start, previous.end).trimEnd().slice(-1))) return segment.start;
	const letter = firstLetter(flat.slice(i, segment.end));
	return letter !== null && /\p{Lu}/u.test(letter) ? i : segment.start;
}

/** The first character after any opening punctuation, or null. */
function firstLetter(text: string): string | null {
	for (const ch of text) {
		if (!OPENERS.includes(ch) && !SPACE_RE.test(ch)) return ch;
	}
	return null;
}

/** The last whitespace-delimited token, without leading opening punctuation. */
function lastToken(text: string): string {
	let start = text.length;
	while (start > 0 && !SPACE_RE.test(text.charAt(start - 1))) start--;
	let token = text.slice(start);
	while (token !== "" && OPENERS.includes(token.charAt(0))) token = token.slice(1);
	return token;
}

function wordCount(text: string): number {
	return text.match(WORD_RE)?.length ?? 0;
}

/** Step 2, last rule: a segment with fewer than two words joins its predecessor, or its successor when first. */
function mergeShort(flat: string, segments: CharRange[]): CharRange[] {
	const result = segments.map((range) => ({ ...range }));
	let k = 0;
	while (result.length > 1 && k < result.length) {
		const range = result[k];
		if (range === undefined || wordCount(flat.slice(range.start, range.end)) >= 2) {
			k++;
			continue;
		}
		const previous = result[k - 1];
		const next = result[k + 1];
		if (previous !== undefined) {
			previous.end = range.end;
			result.splice(k, 1);
		} else if (next !== undefined) {
			next.start = range.start;
			result.splice(k, 1);
		}
	}
	return result;
}

/**
 * Step 3: split before " —" when sentence-final punctuation (and any closers)
 * precedes it. A dash followed by a lower-case letter opens a dialogue tag
 * ("—preguntó él") that belongs to the same sentence, so it is not split.
 */
function splitDialogue(flat: string, range: CharRange): CharRange[] {
	const pieces: CharRange[] = [];
	let start = range.start;
	for (let i = range.start + 1; i < range.end; i++) {
		if (flat.charAt(i) !== "—" || !SPACE_RE.test(flat.charAt(i - 1))) continue;
		let j = i - 1;
		while (j > start && SPACE_RE.test(flat.charAt(j))) j--;
		while (j > start && CLOSERS.includes(flat.charAt(j))) j--;
		if (!TERMINALS.includes(flat.charAt(j))) continue;
		const letter = firstLetter(flat.slice(i + 1, range.end));
		if (letter !== null && /\p{Ll}/u.test(letter)) continue;
		pieces.push({ start, end: i });
		start = i;
	}
	pieces.push({ start, end: range.end });
	return pieces;
}

/** A range without words (a blank verse line, a stray dash) joins its predecessor, or its successor when first. */
function absorbWordless(text: string, ranges: CharRange[]): CharRange[] {
	const result: CharRange[] = [];
	let pendingStart: number | null = null;
	for (const range of ranges) {
		if (!HAS_WORD_RE.test(text.slice(range.start, range.end))) {
			const last = result[result.length - 1];
			if (last === undefined) pendingStart ??= range.start;
			else last.end = range.end;
			continue;
		}
		result.push({ start: pendingStart ?? range.start, end: range.end });
		pendingStart = null;
	}
	return result;
}

/** Moves leading whitespace of each sentence to its predecessor, so every sentence after the first starts visibly. */
function finalize(text: string, ranges: CharRange[]): CharRange[] {
	for (let k = 1; k < ranges.length; k++) {
		const range = ranges[k];
		const previous = ranges[k - 1];
		if (range === undefined || previous === undefined) continue;
		while (range.start < range.end && SPACE_RE.test(text.charAt(range.start))) range.start++;
		previous.end = range.start;
	}
	return ranges;
}
