/**
 * Fits a stored map side to the current words of a unit. Pure; never
 * writes. Owner: align module. DESIGN.md §4.4.
 */
import type { LinkFit, ReconciledSide, SideSig, Word, WordRange } from "../types";
import { bagHash } from "./signature";

/** How far, in words, a proportional cut may move to reach a sentence end. */
const SNAP_WORDS = 3;
/**
 * A sentence end in the text between two words: `.?!…`, optional closing
 * quotes or brackets, then whitespace. The whitespace rules out "3.5" and
 * "1919.Siguiente"-style joins.
 */
const SENTENCE_END_RE = /[.?!…]+["'\p{Pe}\p{Pf}]*\s/u;

/**
 * Prefix/suffix reconciliation: match links from the start, then from the
 * end, by count and hash; the unmatched middle is assigned to a single
 * remaining link ("edited") or split among several by recorded proportions,
 * snapped to sentence punctuation within ±3 words ("approximate").
 * Null stored sides get empty ranges and the fit "empty". Every range is in
 * bounds and ranges are monotone: none starts before the previous one ends.
 * Words left to no link (only on a degraded side) are simply uncovered.
 */
export function reconcileSide(stored: readonly (SideSig | null)[], words: readonly Word[], text: string): ReconciledSide {
	const total = words.length;
	/** Link indices of the non-null sides, in order. */
	const live = stored.flatMap((sig, index) => (sig === null ? [] : [index]));
	const sigs = live.map((index) => stored[index] as SideSig);
	const ranges: WordRange[] = live.map(() => ({ start: 0, end: 0 }));
	const fits: LinkFit[] = live.map(() => "exact");
	const windowMatches = (sig: SideSig, start: number): boolean =>
		start >= 0 &&
		start + sig.count <= total &&
		bagHash(words.slice(start, start + sig.count).map((w) => w.norm)) === sig.hash;

	// 1–3: prefix, then suffix (the fast path is the prefix covering everything).
	let head = 0;
	let pos = 0;
	for (let sig = sigs[head]; sig !== undefined && windowMatches(sig, pos); sig = sigs[head]) {
		ranges[head] = { start: pos, end: pos + sig.count };
		pos += sig.count;
		head++;
	}
	let tail = sigs.length - 1;
	let end = total;
	for (let sig = sigs[tail]; tail >= head && sig !== undefined && end - sig.count >= pos && windowMatches(sig, end - sig.count); sig = sigs[tail]) {
		ranges[tail] = { start: end - sig.count, end };
		end -= sig.count;
		tail--;
	}

	// 4–5: the gap [pos, end) and the unmatched links head..tail.
	const gapLinks = tail - head + 1;
	const gapWords = end - pos;
	if (gapLinks === 0) {
		if (gapWords > 0) absorbLeftover(ranges, fits, head, pos, end);
	} else if (gapWords === 0 || (head === 0 && tail === sigs.length - 1 && sigs.length > 1)) {
		// Nothing left to share, or nothing anchored: positions are unknown.
		for (let k = head; k <= tail; k++) {
			ranges[k] = { start: pos, end: pos };
			fits[k] = "lost";
		}
	} else if (gapLinks === 1) {
		ranges[head] = { start: pos, end };
		fits[head] = "edited";
	} else {
		const cuts = proportionalCuts(sigs.slice(head, tail + 1), pos, end, words, text);
		for (let k = 0; k < gapLinks; k++) {
			const start = k === 0 ? pos : (cuts[k - 1] as number);
			const stop = k === gapLinks - 1 ? end : (cuts[k] as number);
			ranges[head + k] = { start, end: stop };
			fits[head + k] = stop > start ? "approximate" : "lost";
		}
	}
	return expand(stored.length, live, ranges, fits, total);
}

/** Leftover words with every link matched join the preceding link (or the following one at the very start). */
function absorbLeftover(ranges: WordRange[], fits: LinkFit[], head: number, pos: number, end: number): void {
	if (ranges.length === 0) return;
	if (head > 0) {
		const before = ranges[head - 1] as WordRange;
		ranges[head - 1] = { start: before.start, end };
		fits[head - 1] = "edited";
		return;
	}
	const after = ranges[head] as WordRange;
	ranges[head] = { start: pos, end: after.end };
	fits[head] = "edited";
}

/**
 * Cuts dividing [pos, end) among links in proportion to their stored counts,
 * each moved to the nearest sentence end within SNAP_WORDS words. A cut is a
 * word index: the first word of the next link. Cuts are non-decreasing, and
 * when the gap has at least one word per link every link keeps at least one.
 */
function proportionalCuts(sigs: readonly SideSig[], pos: number, end: number, words: readonly Word[], text: string): number[] {
	const storedTotal = sigs.reduce((sum, sig) => sum + sig.count, 0);
	const gap = end - pos;
	const roomForAll = gap >= sigs.length;
	const cuts: number[] = [];
	let cumulative = 0;
	let previous = pos;
	for (const [k, sig] of sigs.slice(0, -1).entries()) {
		cumulative += sig.count;
		const linksAfter = sigs.length - 1 - k;
		const min = roomForAll ? previous + 1 : previous;
		const max = roomForAll ? end - linksAfter : end;
		const ideal = clamp(pos + Math.round((gap * cumulative) / storedTotal), min, max);
		// A snapped cut always leaves both neighbours at least one word.
		const cut = snapToSentenceEnd(ideal, previous + 1, Math.min(max, end - 1), words, text);
		cuts.push(cut);
		previous = cut;
	}
	return cuts;
}

/** The candidate in [min, max] nearest `ideal` that follows a sentence end, or `ideal`. */
function snapToSentenceEnd(ideal: number, min: number, max: number, words: readonly Word[], text: string): number {
	for (let distance = 0; distance <= SNAP_WORDS; distance++) {
		for (const candidate of [ideal - distance, ideal + distance]) {
			if (candidate < min || candidate > max) continue;
			const before = words[candidate - 1];
			const after = words[candidate];
			if (before === undefined || after === undefined) continue;
			if (SENTENCE_END_RE.test(text.slice(before.end, after.start))) return candidate;
		}
	}
	return ideal;
}

/** Spreads the live links' results back over all stored links; null sides get empty ranges at their position. */
function expand(count: number, live: readonly number[], ranges: readonly WordRange[], fits: readonly LinkFit[], total: number): ReconciledSide {
	const allRanges: WordRange[] = [];
	const allFits: LinkFit[] = [];
	let cursor = 0;
	let k = 0;
	for (let index = 0; index < count; index++) {
		if (live[k] === index) {
			const range = ranges[k] as WordRange;
			allRanges.push(range);
			allFits.push(fits[k] as LinkFit);
			cursor = range.end;
			k++;
		} else {
			allRanges.push({ start: cursor, end: cursor });
			allFits.push("empty");
		}
	}
	const covered = allRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
	let status: ReconciledSide["status"] = "exact";
	if (allFits.some((f) => f === "approximate" || f === "lost") || covered < total) status = "degraded";
	else if (allFits.includes("edited")) status = "repaired";
	return { status, ranges: allRanges, fits: allFits };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
