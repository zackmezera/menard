/**
 * Word tokenization shared by every projection. Pure. Owner: align module.
 * DESIGN.md §4.3.
 */
import type { Word } from "../types";

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const MARK_RE = /\p{M}/gu;

/**
 * Maximal runs of /[\p{L}\p{N}\p{M}]+/u in `text`, with normalized forms.
 * `text` is expected to be NFC already (every projection is); offsets index
 * `text` exactly as given.
 */
export function wordsOf(text: string): Word[] {
	const words: Word[] = [];
	for (const match of text.matchAll(WORD_RE)) {
		const start = match.index;
		words.push({ start, end: start + match[0].length, norm: normalizeWord(match[0]) });
	}
	return words;
}

/** NFKD, combining marks removed, lower-cased. */
export function normalizeWord(word: string): string {
	return word.normalize("NFKD").replace(MARK_RE, "").toLowerCase();
}
