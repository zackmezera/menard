/**
 * The `%%menard:1 …%%` line grammar: parse, serialize, validate.
 * Pure. Owner: align module. DESIGN.md §4.3 (grammar), ADR 0006.
 */
import { MAP_VERSION, MENARD_LINE_PREFIX } from "../constants";
import type { MapLink, MenardLine, SideSig, Word, WordRange } from "../types";
import { sideSig } from "./signature";

const LINE_OPEN = "%%menard:";
const LINE_CLOSE = "%%";
const KEY_RE = /^(?:[A-Za-z0-9-]+|fn:[A-Za-z0-9_-]+)$/;
/** A key group (ADR 0010): two or more block ids joined by "+". */
const GROUP_RE = /^[A-Za-z0-9-]+(?:\+[A-Za-z0-9-]+)+$/;
const SIDE_RE = /^(?:-|([1-9][0-9]{0,3})\.([0-9a-z]{4}))$/;
const HASH_RE = /^[0-9a-z]{4}$/;
const MAX_COUNT = 9999;

/** Parses one whole line; returns an error string if it is Menard-owned but malformed. */
export function parseMenardLine(raw: string): MenardLine | { error: string } {
	if (!raw.startsWith(LINE_OPEN)) return { error: `not a Menard line: it must start with "${MENARD_LINE_PREFIX}"` };
	if (!raw.endsWith(LINE_CLOSE) || raw.length < LINE_OPEN.length + LINE_CLOSE.length) {
		return { error: `unterminated Menard line: it must end with "${LINE_CLOSE}"` };
	}
	const inner = raw.slice(LINE_OPEN.length, raw.length - LINE_CLOSE.length);
	if (/[%\r\n]/.test(inner)) return { error: "a Menard line may not contain '%' or a line break inside it" };

	const [version, key, ...body] = inner.split(" ");
	if (version !== String(MAP_VERSION)) return { error: `unsupported Menard line version "${version ?? ""}" (expected ${MAP_VERSION})` };
	if (key === undefined || key === "") return { error: "missing unit key after the version" };
	const group = parseGroup(key);
	if (!KEY_RE.test(key) && group === undefined) return { error: `invalid unit key "${key}": expected a block id, fn:<label> or ids joined by +` };
	if (group === null) return { error: `key group "${key}" names a block id twice` };
	if (body.length === 0) return { error: `missing body after key "${key}": expected translate, align or links` };
	const keyed = group === undefined ? { key } : { key: group[0] as string, group };

	if (body.length === 1 && (body[0] === "translate" || body[0] === "align")) {
		return { kind: "marker", ...keyed, task: body[0] };
	}
	const links: MapLink[] = [];
	for (const [index, token] of body.entries()) {
		const link = parseLink(token);
		if ("error" in link) return { error: `link ${index + 1} ("${token}"): ${link.error}` };
		links.push(link);
	}
	return { kind: "map", ...keyed, links };
}

/** The ids of a key group "p3+p4"; undefined when `token` is not one, null when an id repeats. */
function parseGroup(token: string): string[] | null | undefined {
	if (!GROUP_RE.test(token)) return undefined;
	const ids = token.split("+");
	return new Set(ids).size === ids.length ? ids : null;
}

/** The key written on a Menard line: the key group "p3+p4" of a merged unit, else the key. */
export function lineKey(line: Pick<MenardLine, "key" | "group">): string {
	return line.group === undefined ? line.key : line.group.join("+");
}

/** Canonical serialization; parseMenardLine(serializeMenardLine(x)) deep-equals x. Throws on invalid input. */
export function serializeMenardLine(line: MenardLine): string {
	const key = lineKey(line);
	const group = line.group === undefined ? undefined : parseGroup(key);
	if (line.group === undefined ? !KEY_RE.test(key) : !group || group[0] !== line.key) throw new RangeError(`invalid Menard key "${key}"`);
	if (line.kind === "marker") return `${MENARD_LINE_PREFIX}${key} ${line.task}${LINE_CLOSE}`;
	const errors = validateLinks(line.links);
	if (errors.length > 0) throw new RangeError(`invalid sentence map for "${line.key}": ${errors.join("; ")}`);
	const body = line.links.map((l) => `${serializeSide(l.src)}/${serializeSide(l.tgt)}${l.loose ? "?" : ""}`).join(" ");
	return `${MENARD_LINE_PREFIX}${key} ${body}${LINE_CLOSE}`;
}

/** Structural errors: empty list, a link with both sides null, counts < 1, bad hashes. */
export function validateLinks(links: readonly MapLink[]): string[] {
	if (links.length === 0) return ["a sentence map needs at least one link"];
	const errors: string[] = [];
	links.forEach((link, index) => {
		const where = `link ${index + 1}`;
		if (link.src === null && link.tgt === null) errors.push(`${where}: both sides are empty`);
		for (const [name, sig] of [["source", link.src], ["target", link.tgt]] as const) {
			if (sig === null) continue;
			if (!Number.isInteger(sig.count) || sig.count < 1 || sig.count > MAX_COUNT) {
				errors.push(`${where}: ${name} count ${sig.count} is not an integer from 1 to ${MAX_COUNT}`);
			}
			if (!HASH_RE.test(sig.hash)) errors.push(`${where}: ${name} hash "${sig.hash}" is not 4 lower-case base-36 characters`);
		}
	});
	return errors;
}

/**
 * Builds links from parallel word ranges of the two sides. `src[i]`/`tgt[i]`
 * may be empty ranges (flagged span) but not both. On each side the
 * non-empty ranges must partition all its words in order, so the stored
 * counts always sum to the projection's word count; throws otherwise.
 */
export function linksFromRanges(
	source: { words: readonly Word[]; ranges: readonly WordRange[] },
	target: { words: readonly Word[]; ranges: readonly WordRange[] },
	loose: readonly boolean[],
): MapLink[] {
	const n = source.ranges.length;
	if (target.ranges.length !== n || loose.length !== n) {
		throw new RangeError(`linksFromRanges: ${n} source ranges, ${target.ranges.length} target ranges, ${loose.length} loose flags`);
	}
	const links = source.ranges.map((srcRange, i) => {
		const tgtRange = target.ranges[i] as WordRange;
		const src = srcRange.end > srcRange.start ? sideSig(source.words, srcRange) : null;
		const tgt = tgtRange.end > tgtRange.start ? sideSig(target.words, tgtRange) : null;
		if (src === null && tgt === null) throw new RangeError(`linksFromRanges: link ${i + 1} is empty on both sides`);
		return { src, tgt, loose: loose[i] === true };
	});
	assertPartition("source", source.words.length, source.ranges);
	assertPartition("target", target.words.length, target.ranges);
	return links;
}

/** The stored signatures of one side, in link order (null for an empty side). */
export function sideOf(links: readonly MapLink[], side: "src" | "tgt"): (SideSig | null)[] {
	return links.map((link) => link[side]);
}

function assertPartition(side: string, wordCount: number, ranges: readonly WordRange[]): void {
	let next = 0;
	ranges.forEach((range, i) => {
		if (range.end < range.start) throw new RangeError(`linksFromRanges: ${side} range ${i + 1} ends before it starts`);
		if (range.end === range.start) return;
		if (range.start !== next) {
			throw new RangeError(`linksFromRanges: ${side} range ${i + 1} starts at word ${range.start}, expected ${next}`);
		}
		next = range.end;
	});
	if (next !== wordCount) throw new RangeError(`linksFromRanges: ${side} ranges cover ${next} of ${wordCount} words`);
}

function parseLink(token: string): MapLink | { error: string } {
	if (token === "") return { error: "empty link (two spaces in a row?)" };
	const loose = token.endsWith("?");
	const sides = (loose ? token.slice(0, -1) : token).split("/");
	if (sides.length !== 2) return { error: 'expected "<source>/<target>"' };
	const src = parseSide(sides[0] as string);
	const tgt = parseSide(sides[1] as string);
	if (src === undefined) return { error: `bad source side "${sides[0]}": expected "-" or <count>.<hash>` };
	if (tgt === undefined) return { error: `bad target side "${sides[1]}": expected "-" or <count>.<hash>` };
	if (src === null && tgt === null) return { error: "both sides are empty" };
	return { src, tgt, loose };
}

/** null for "-", undefined when malformed. */
function parseSide(text: string): SideSig | null | undefined {
	const match = SIDE_RE.exec(text);
	if (!match) return undefined;
	if (match[1] === undefined || match[2] === undefined) return null;
	return { count: Number(match[1]), hash: match[2] };
}

function serializeSide(sig: SideSig | null): string {
	return sig === null ? "-" : `${sig.count}.${sig.hash}`;
}
