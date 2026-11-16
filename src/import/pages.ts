/**
 * Places print page markers in a chapter note from the openings of PDF
 * pages. Both sides are reduced to bare lowercase letters (no accents, no
 * whitespace, no digits or punctuation), which absorbs OCR that splits words
 * ("u n a", "abiertam ente"); each page's opening is then found by
 * character-trigram overlap in a window that only moves forward. Pure; the
 * result is a list of inserts for SafeWriter.insert. Owner: import module.
 * DESIGN.md §16.
 */
import type { Insert } from "../types";

export interface PageOpening {
	/** The printed page label, e.g. "17". */
	label: string;
	/** The page's first letters, already reduced (see `reduce`). */
	opening: string;
	/** All letters on the page, to bound how far ahead to look. */
	letters?: number;
}

export interface PlaceResult {
	inserts: Insert[];
	placed: { label: string; at: number; score: number }[];
	skipped: { label: string; reason: string }[];
}

/** Below this share of matching trigrams a page is not placed. */
export const MIN_SCORE = 0.6;
/** Openings shorter than this many letters are not trusted. */
const MIN_LETTERS = 24;

const MARKER_RE = /%%p\. ([^%\n]+)%%/g;

/** Lowercase letters only, accents and ligatures decomposed. */
export function reduce(text: string): string {
	return text.normalize("NFKD").replace(/[^\p{L}]/gu, "").toLowerCase();
}

/** The searchable letters of a note and each letter's offset in it. */
function haystack(text: string): { hay: string; at: number[] } {
	const skip: [number, number][] = [];
	const fm = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
	if (fm) skip.push([0, fm[0].length]);
	const patterns = [/%%[\s\S]*?%%/g, /\[\^[^\]\n]+\](?!:)/g, /^\[\^[^\]\n]+\]:.*(\r?\n( {4}|\t).*)*/gm, /\s\^[A-Za-z0-9-]+$/gm, /\]\([^)\n]*\)/g];
	for (const pattern of patterns) for (const m of text.matchAll(pattern)) skip.push([m.index, m.index + m[0].length]);
	skip.sort((a, b) => a[0] - b[0]);
	let hay = "";
	const at: number[] = [];
	let s = 0;
	for (let i = 0; i < text.length; i++) {
		while (s < skip.length && skip[s]![1] <= i) s++;
		if (s < skip.length && skip[s]![0] <= i) {
			i = skip[s]![1] - 1;
			continue;
		}
		const letters = reduce(text[i]!);
		for (const letter of letters) {
			hay += letter;
			at.push(i);
		}
	}
	return { hay, at };
}

export function placePageMarkers(text: string, pages: readonly PageOpening[]): PlaceResult {
	const { hay, at } = haystack(text);
	const grams = trigramIds(hay);
	const existing = new Map<string, number>();
	for (const m of text.matchAll(MARKER_RE)) existing.set(m[1]!.trim(), lowerBound(at, m.index));
	const spans = pages.map((page) => page.letters ?? 0).filter((n) => n > 0);
	// ponytail: look at most ~5 pages ahead (at least 5000 letters), so a page set wider than the chapter stays cheap.
	const span = spans.length > 0 ? Math.max(5 * median(spans), 5000) : Infinity;

	const result: PlaceResult = { inserts: [], placed: [], skipped: [] };
	let cursor = 0;
	let lastOffset = -1;
	for (const page of pages) {
		const known = existing.get(page.label);
		if (known !== undefined) {
			result.skipped.push({ label: page.label, reason: "already marked" });
			cursor = Math.max(cursor, known);
			continue;
		}
		const needle = page.opening;
		if (needle.length < MIN_LETTERS) {
			result.skipped.push({ label: page.label, reason: "too little text on the page" });
			continue;
		}
		const ceiling = Math.min(hay.length, cursor + span, nextExisting(existing, page.label, hay.length, cursor));
		const found = bestWindow(grams, needle, cursor, ceiling);
		if (!found || found.score < MIN_SCORE) {
			result.skipped.push({ label: page.label, reason: `no confident match (best ${Math.round((found?.score ?? 0) * 100)}%)` });
			continue;
		}
		const insert = markerInsert(text, at[found.start]!, page.label);
		if (insert.at <= lastOffset) {
			result.skipped.push({ label: page.label, reason: "would land before the previous page" });
			continue;
		}
		result.inserts.push(insert);
		result.placed.push({ label: page.label, at: insert.at, score: found.score });
		lastOffset = insert.at;
		cursor = found.start + 1;
	}
	return result;
}

/** The hay index of the nearest existing marker whose numeric label is above `label`. */
function nextExisting(existing: Map<string, number>, label: string, fallback: number, from: number): number {
	const n = Number(label);
	let best = fallback;
	if (!Number.isFinite(n)) return best;
	for (const [other, index] of existing) if (Number(other) > n && index >= from && index < best) best = index;
	return best;
}

/** Trigram ids for every position of the haystack, and the dictionary that numbers them. */
function trigramIds(hay: string): { ids: Int32Array; dictionary: Map<string, number> } {
	const dictionary = new Map<string, number>();
	const ids = new Int32Array(Math.max(0, hay.length - 2));
	for (let i = 0; i < ids.length; i++) {
		const gram = hay.slice(i, i + 3);
		let id = dictionary.get(gram);
		if (id === undefined) dictionary.set(gram, (id = dictionary.size));
		ids[i] = id;
	}
	return { ids, dictionary };
}

/**
 * The start in [from, to) whose window has the most of the needle's trigrams
 * at about the same position (±3 letters, for OCR drift). Among equal counts
 * the closer fit wins, then the earlier start.
 */
function bestWindow(grams: { ids: Int32Array; dictionary: Map<string, number> }, needle: string, from: number, to: number): { start: number; score: number } | null {
	const n = needle.length - 2;
	const where = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const id = grams.dictionary.get(needle.slice(i, i + 3));
		if (id !== undefined) where.set(id, [...(where.get(id) ?? []), i]);
	}
	const end = Math.min(to, grams.ids.length);
	if (end <= from || where.size === 0) return null;
	let best = { start: from, count: -1, fit: -1 };
	for (let s = from; s < end; s++) {
		let count = 0;
		let fit = 0;
		for (let i = 0; i < n && s + i < grams.ids.length; i++) {
			const at = where.get(grams.ids[s + i]!);
			if (!at) continue;
			const drift = Math.min(...at.map((j) => Math.abs(j - i)));
			if (drift <= 3) {
				count++;
				fit += 3 - drift;
			}
		}
		if (count > best.count || (count === best.count && fit > best.fit)) best = { start: s, count, fit };
	}
	// OCR drift accumulates toward the tail, so the exact start is where the head matches exactly.
	const head = (start: number): number => {
		let exact = 0;
		for (let i = 0; i < Math.min(12, n) && start + i < grams.ids.length; i++) {
			if (grams.ids[start + i] === grams.dictionary.get(needle.slice(i, i + 3))) exact++;
		}
		return exact;
	};
	let start = best.start;
	for (const shift of [1, -1, 2, -2, 3, -3]) {
		const candidate = best.start + shift;
		if (candidate >= from && candidate < end && head(candidate) > head(start)) start = candidate;
	}
	return { start, score: best.count / n };
}

/** `%%p. N%%` at the nearest word boundary; before a heading, on a line of its own. */
function markerInsert(text: string, offset: number, label: string): Insert {
	const marker = `%%p. ${label}%%`;
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	if (/^#{1,6}\s/.test(text.slice(lineStart))) return { at: lineStart, text: `${marker}\n\n` };
	let start = offset;
	while (start > lineStart && !/\s/.test(text[start - 1]!)) start--;
	let end = offset;
	while (end < text.length && !/\s/.test(text[end]!)) end++;
	const next = /[^\S\n]+(?=\S)/y;
	next.lastIndex = end;
	const at = offset - start <= end - offset || !next.test(text) ? start : next.lastIndex;
	return { at, text: `${marker} ` };
}

function lowerBound(sorted: number[], value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? 0;
}
