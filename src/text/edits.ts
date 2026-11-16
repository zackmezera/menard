/**
 * String edits and their verification. Pure. Owner: text module.
 * DESIGN.md §8 (write classes).
 */
import { MENARD_LINE_PREFIX } from "../constants";
import { MenardError } from "../errors";
import type { Insert, Replacement } from "../types";
import { parseNote } from "./blocks";

/** Applies insertions (any order in the array) to `text`. Insertions at the same offset keep their array order. */
export function applyInserts(text: string, inserts: readonly Insert[]): string {
	const sorted = sortInserts(inserts);
	let out = "";
	let cursor = 0;
	for (const insert of sorted) {
		if (insert.at < 0 || insert.at > text.length) throw new RangeError(`Insert offset ${insert.at} is outside the text`);
		out += text.slice(cursor, insert.at) + insert.text;
		cursor = insert.at;
	}
	return out + text.slice(cursor);
}

/** True when removing the inserted ranges from `after` yields `before` exactly. */
export function isInsertOnly(before: string, after: string, inserts: readonly Insert[]): boolean {
	const added = inserts.reduce((sum, insert) => sum + insert.text.length, 0);
	if (after.length !== before.length + added) return false;
	let shift = 0;
	let cursor = 0;
	let rebuilt = "";
	for (const insert of sortInserts(inserts)) {
		if (insert.at < 0 || insert.at > before.length) return false;
		const at = insert.at + shift;
		if (after.slice(at, at + insert.text.length) !== insert.text) return false;
		rebuilt += after.slice(cursor, at);
		cursor = at + insert.text.length;
		shift += insert.text.length;
	}
	return rebuilt + after.slice(cursor) === before;
}

/**
 * Applies non-overlapping replacements. Throws MenardError("write-conflict")
 * if any `expect` differs from the current slice.
 */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
	const sorted = replacements.map((r, order) => ({ r, order })).sort((a, b) => a.r.from - b.r.from || a.order - b.order);
	let out = "";
	let cursor = 0;
	for (const { r } of sorted) {
		if (r.from < cursor || r.to < r.from || r.to > text.length) {
			throw new MenardError("write-conflict", `Replacement [${r.from}, ${r.to}) overlaps another or lies outside the text`);
		}
		if (text.slice(r.from, r.to) !== r.expect) {
			throw new MenardError("write-conflict", `The text at [${r.from}, ${r.to}) changed since the edit was computed`);
		}
		out += text.slice(cursor, r.from) + r.text;
		cursor = r.to;
	}
	return out + text.slice(cursor);
}

/** Character offset where each line starts; length = line count + 1 (last entry = text.length). */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	starts.push(text.length);
	return starts;
}

/** End of line `n`'s content (before "\n" or "\r\n"), given `starts = lineStarts(text)`. */
export function lineEnd(text: string, starts: readonly number[], n: number): number {
	if (n + 2 >= starts.length) return text.length;
	const end = (starts[n + 1] ?? text.length) - 1;
	return text.charAt(end - 1) === "\r" ? end - 1 : end;
}

/**
 * Every whole Menard line with its key, as character ranges (line content
 * only, no EOL). `keys` holds every id of a key group "p3+p4" (ADR 0010);
 * `key` is the first. The lines are exactly the `menard` blocks of
 * `parseNote`, so jobs and the writer own what the reader reads, and
 * nothing in fenced code or a user's `%%` block (#35).
 */
export function locateMenardLines(text: string): { key: string; keys: string[]; from: number; to: number; raw: string }[] {
	const starts = lineStarts(text);
	return parseNote(text, { textStartHeading: "", skipHeadings: [] }).blocks.flatMap((block) => {
		if (block.kind !== "menard") return [];
		const from = starts[block.lines.start] ?? 0;
		const to = lineEnd(text, starts, block.lines.start);
		const raw = text.slice(from, to);
		const keys = (raw.slice(MENARD_LINE_PREFIX.length).split(" ")[0] ?? "").split("+");
		return [{ key: keys[0] ?? "", keys, from, to, raw }];
	});
}

function sortInserts(inserts: readonly Insert[]): Insert[] {
	return inserts
		.map((insert, order) => ({ insert, order }))
		.sort((a, b) => a.insert.at - b.insert.at || a.order - b.order)
		.map(({ insert }) => insert);
}
