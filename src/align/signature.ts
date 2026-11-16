/**
 * Link-side signatures: word count plus an order-insensitive word-bag hash.
 * Pure. Owner: align module. DESIGN.md §4.3 (known-answer vectors there).
 */
import type { SideSig, Word, WordRange } from "../types";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_MODULUS = 36 ** 4;

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(input: string): number {
	let hash = FNV_OFFSET;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return hash >>> 0;
}

/** 4 base-36 chars of fnv1a32(sorted normalized words joined by " ") mod 36^4. */
export function bagHash(norms: readonly string[]): string {
	const joined = [...norms].sort(compareCodeUnits).join(" ");
	return (fnv1a32(joined) % HASH_MODULUS).toString(36).padStart(4, "0");
}

/** Signature of words[range.start, range.end); the range must be non-empty. */
export function sideSig(words: readonly Word[], range: WordRange): SideSig {
	if (range.start < 0 || range.end > words.length || range.end <= range.start) {
		throw new RangeError(`sideSig: invalid word range [${range.start}, ${range.end}) of ${words.length}`);
	}
	const norms = words.slice(range.start, range.end).map((w) => w.norm);
	return { count: norms.length, hash: bagHash(norms) };
}

/** Locale-independent ordering by UTF-16 code units, as Array.prototype.sort does by default. */
function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
