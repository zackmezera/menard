/**
 * Turns per-link word ranges into character ranges of a projection, by the
 * token-start rule. Shared by the DOM wrapper and the gloss. Pure.
 * Owner: align module. DESIGN.md §4.4.
 */
import type { CharRange, Word, WordRange } from "../types";

const WHITESPACE_RE = /\s/u;

/**
 * Character ranges, one per link. The cut before link i+1 is the start of
 * the whitespace-delimited token holding its first word (so opening «“¿( go
 * with it), unless that token also holds link i's last word, in which case
 * the cut is the word's start. Link 1 starts at 0; the last link ends at
 * text.length. Empty word ranges give empty character ranges.
 *
 * The result is contiguous and covers [0, text.length): each range starts
 * where the previous one ends, and an empty link sits at the cut where it
 * falls.
 */
export function linkCharRanges(text: string, words: readonly Word[], ranges: readonly WordRange[]): CharRange[] {
	/** Start of each non-empty link; null for an empty one, which takes the next link's start. */
	const starts: (number | null)[] = [];
	let previousLast: Word | null = null;
	let previousStart = 0;
	for (const range of ranges) {
		const first = range.end > range.start ? words[range.start] : undefined;
		const last = range.end > range.start ? words[range.end - 1] : undefined;
		if (first === undefined || last === undefined) {
			starts.push(null);
			continue;
		}
		const start = previousLast === null ? 0 : Math.max(previousStart, cutBefore(text, first, previousLast));
		starts.push(start);
		previousStart = start;
		previousLast = last;
	}
	const result: CharRange[] = new Array<CharRange>(starts.length);
	let end = text.length;
	for (let i = starts.length - 1; i >= 0; i--) {
		const start = starts[i] ?? end;
		result[i] = { start, end };
		end = start;
	}
	return result;
}

function cutBefore(text: string, first: Word, previousLast: Word): number {
	let tokenStart = first.start;
	while (tokenStart > 0 && !WHITESPACE_RE.test(text.charAt(tokenStart - 1))) tokenStart--;
	return tokenStart < previousLast.end ? first.start : tokenStart;
}
