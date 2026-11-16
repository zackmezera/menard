/**
 * Builds the immutable PairModel from both notes' structures. Pure.
 * Owner: align module. DESIGN.md §6.
 */
import { SENTENCE_UNIT_KINDS } from "../types";
import type {
	Block,
	CursorStop,
	LineRange,
	MenardLine,
	MenardLineOccurrence,
	NoteStructure,
	PairLanguages,
	PairModel,
	PairUnit,
	ScrollAnchor,
	Side,
	UnitKey,
	UnitKind,
} from "../types";
import { parseMenardLine } from "./map";

export interface PairModelInput {
	sourcePath: string;
	targetPath: string;
	languages: PairLanguages;
	version: number;
	source: NoteStructure;
	target: NoteStructure;
}

type MapLine = Extract<MenardLine, { kind: "map" }>;

const PREFIXED_FOOTNOTE_RE = /^[A-Za-z]+-(\d+)$/;

/**
 * Pairs units by key (same block id on both notes), footnotes by
 * normalized label, headings by the next paired unit; parses the
 * target's Menard lines and attaches maps and pending markers by key.
 *
 * A text-region block with no key (a paragraph without a block id yet) is
 * not a unit. When one note repeats a key, its first block wins. A Menard
 * line naming a key group (ADR 0010) merges its keys into one unit, keyed
 * by the group's first key; `unit()` answers for every key of the group.
 */
export function buildPairModel(input: PairModelInput): PairModel {
	const { source: sourceUnits, target: targetUnits } = keyedPair(input.source, input.target);
	const lines = attachMenardLines(input.target, sourceUnits, targetUnits);
	const units = orderUnits(sourceUnits, targetUnits, lines);
	const byKey = new Map(units.flatMap((u) => (u.group?.keys ?? [u.key]).map((key) => [key, u] as const)));
	const lineIndex = { source: indexLines(units, "source", lines.mapLines), target: indexLines(units, "target", lines.mapLines) };

	let stopsCache: readonly CursorStop[] | null = null;
	let anchorsCache: readonly ScrollAnchor[] | null = null;
	return {
		sourcePath: input.sourcePath,
		targetPath: input.targetPath,
		languages: input.languages,
		version: input.version,
		units,
		problems: lines.problems,
		unit: (key) => byKey.get(key),
		unitAtLine: (side, line) => lineIndex[side].get(line),
		stops: () => (stopsCache ??= computeStops(units)),
		anchors: () => (anchorsCache ??= computeAnchors(units)),
	};
}

/** The blocks of one side of a unit, in group order: several for a merged unit, else zero or one. */
export function unitBlocks(unit: PairUnit, side: Side): readonly Block[] {
	if (unit.group) return unit.group[side];
	const block = unit[side];
	return block === null ? [] : [block];
}

/** "fn:<n>" for labels like "3", "en-3", "gen-3"; "fn:<label>" otherwise. */
export function footnoteKey(label: string): UnitKey {
	const prefixed = PREFIXED_FOOTNOTE_RE.exec(label);
	return `fn:${prefixed?.[1] ?? label}`;
}

interface KeyedUnit {
	key: UnitKey;
	kind: UnitKind;
	block: Block;
}

function isUnitKind(kind: Block["kind"]): kind is UnitKind {
	return kind !== "verbatim" && kind !== "menard";
}

function isSentenceKind(kind: UnitKind): boolean {
	return SENTENCE_UNIT_KINDS.includes(kind);
}

/** A text-region unit block in document order, before headings are keyed. */
interface Entry {
	kind: UnitKind;
	block: Block;
	/** Null for a heading (keyed by pairing) or an unkeyed block. */
	key: UnitKey | null;
}

function entries(note: NoteStructure): Entry[] {
	const out: Entry[] = [];
	const seen = new Set<UnitKey>();
	for (const block of note.blocks) {
		if (block.region !== "text" || !isUnitKind(block.kind)) continue;
		let key: UnitKey | null = null;
		if (block.kind === "footnote") key = block.footnoteLabel === undefined ? null : footnoteKey(block.footnoteLabel);
		else if (block.kind !== "heading") key = block.id;
		// The first block wins a repeated key; later ones are not units.
		if (key !== null && seen.has(key)) continue;
		if (key !== null) seen.add(key);
		out.push({ kind: block.kind, block, key });
	}
	return out;
}

/**
 * For each paired key, the index (into `list`) of the heading that
 * immediately precedes its block, when no other keyed-and-paired unit
 * stands between that heading and the block.
 */
function headingsBeforePaired(list: readonly Entry[], paired: ReadonlySet<UnitKey>): Map<UnitKey, number> {
	const out = new Map<UnitKey, number>();
	let heading: number | null = null;
	list.forEach((entry, i) => {
		if (entry.kind === "heading") heading = i;
		else if (entry.key !== null && paired.has(entry.key)) {
			if (heading !== null) out.set(entry.key, heading);
			heading = null;
		}
	});
	return out;
}

/**
 * Both notes' text-region units in document order, keyed; the first block
 * wins a repeated key. Headings pair by the next paired unit: a heading
 * pairs with the other note's heading that immediately precedes the
 * partner of the first paired unit following it, so an extra or missing
 * heading on one side does not shift every later heading. A paired heading
 * is "h:<source ordinal>"; an unpaired one is "h:<ordinal>" on the source
 * and "h:t<ordinal>" on the translation. Keys live in memory only.
 */
function keyedPair(source: NoteStructure, target: NoteStructure): { source: Map<UnitKey, KeyedUnit>; target: Map<UnitKey, KeyedUnit> } {
	const src = entries(source);
	const tgt = entries(target);
	const tgtKeys = new Set(tgt.flatMap((e) => (e.key === null ? [] : [e.key])));
	const paired = new Set(src.flatMap((e) => (e.key !== null && tgtKeys.has(e.key) ? [e.key] : [])));
	const srcBefore = headingsBeforePaired(src, paired);
	const tgtBefore = headingsBeforePaired(tgt, paired);

	const srcKeys = new Map<number, UnitKey>();
	let ordinal = 0;
	src.forEach((entry, i) => {
		if (entry.kind === "heading") srcKeys.set(i, `h:${++ordinal}`);
	});
	const tgtHeadingKeys = new Map<number, UnitKey>();
	for (const [key, si] of srcBefore) {
		const ti = tgtBefore.get(key);
		const hk = srcKeys.get(si);
		if (ti !== undefined && hk !== undefined) tgtHeadingKeys.set(ti, hk);
	}
	ordinal = 0;
	tgt.forEach((entry, i) => {
		if (entry.kind !== "heading") return;
		ordinal++;
		if (!tgtHeadingKeys.has(i)) tgtHeadingKeys.set(i, `h:t${ordinal}`);
	});

	const collect = (list: readonly Entry[], headingKeys: Map<number, UnitKey>): Map<UnitKey, KeyedUnit> => {
		const units = new Map<UnitKey, KeyedUnit>();
		list.forEach((entry, i) => {
			const key = entry.kind === "heading" ? headingKeys.get(i) : entry.key;
			if (key !== undefined && key !== null) units.set(key, { key, kind: entry.kind, block: entry.block });
		});
		return units;
	};
	return { source: collect(src, srcKeys), target: collect(tgt, tgtHeadingKeys) };
}

interface AttachedLines {
	maps: Map<UnitKey, MapLine>;
	mapLines: Map<UnitKey, number>;
	pending: Map<UnitKey, "translate" | "align">;
	/** Key groups by their first key; `grouped` maps every member key to its group's first key. */
	groups: Map<UnitKey, readonly UnitKey[]>;
	grouped: Map<UnitKey, UnitKey>;
	problems: MenardLineOccurrence[];
}

function attachMenardLines(target: NoteStructure, sourceUnits: Map<UnitKey, KeyedUnit>, targetUnits: Map<UnitKey, KeyedUnit>): AttachedLines {
	const result: AttachedLines = { maps: new Map(), mapLines: new Map(), pending: new Map(), groups: new Map(), grouped: new Map(), problems: [] };
	const lines: { line: number; raw: string; parsed: MenardLine }[] = [];
	for (const block of target.blocks) {
		if (block.kind !== "menard") continue;
		const raw = block.raw.trimEnd();
		const parsed = parseMenardLine(raw);
		if ("error" in parsed) result.problems.push({ line: block.lines.start, raw, parsed: null, error: parsed.error });
		else lines.push({ line: block.lines.start, raw, parsed });
	}
	// Groups first, so a plain line naming a grouped key is found out wherever it stands.
	const plain: typeof lines = [];
	for (const entry of lines) {
		if (entry.parsed.group === undefined) {
			plain.push(entry);
			continue;
		}
		const error = groupError(entry.parsed.group, sourceUnits, targetUnits, result.grouped);
		if (error !== null) {
			result.problems.push({ ...entry, error });
			continue;
		}
		result.groups.set(entry.parsed.key, entry.parsed.group);
		for (const key of entry.parsed.group) result.grouped.set(key, entry.parsed.key);
		attachLine(entry, result);
	}
	for (const entry of plain) {
		const { parsed } = entry;
		const problem = (error: string): void => {
			result.problems.push({ ...entry, error });
		};
		if (result.grouped.has(parsed.key)) problem(`"${parsed.key}" belongs to the merged unit "${result.grouped.get(parsed.key)}"; this line is ignored`);
		else if (parsed.kind === "map") {
			const unit = targetUnits.get(parsed.key);
			// The pair's kind comes from the source block when there is one (orderUnits does the same).
			const kind = sourceUnits.get(parsed.key)?.kind ?? unit?.kind;
			if (unit === undefined) problem(`sentence map for "${parsed.key}", which has no unit in the translation note`);
			else if (kind !== undefined && !isSentenceKind(kind)) problem(`sentence map for "${parsed.key}", a ${kind}, which aligns whole`);
			else attachLine(entry, result);
		} else if (!sourceUnits.has(parsed.key)) {
			problem(`"${parsed.task}" marker for "${parsed.key}", which has no unit in the source note`);
		} else {
			attachLine(entry, result);
		}
	}
	result.problems.sort((a, b) => a.line - b.line);
	return result;
}

/** Attaches a map or marker by its (first) key, unless that key already has one. */
function attachLine(entry: { line: number; raw: string; parsed: MenardLine }, result: AttachedLines): void {
	const { parsed, line } = entry;
	if (parsed.kind === "map") {
		if (result.maps.has(parsed.key)) result.problems.push({ ...entry, error: `duplicate sentence map for "${parsed.key}"; the first one is used` });
		else {
			result.maps.set(parsed.key, parsed);
			result.mapLines.set(parsed.key, line);
		}
	} else if (result.pending.has(parsed.key)) {
		result.problems.push({ ...entry, error: `duplicate marker for "${parsed.key}"; the first one is used` });
	} else {
		result.pending.set(parsed.key, parsed.task);
	}
}

/** Why a key group cannot form a merged unit, or null. */
function groupError(
	keys: readonly UnitKey[],
	sourceUnits: Map<UnitKey, KeyedUnit>,
	targetUnits: Map<UnitKey, KeyedUnit>,
	grouped: ReadonlyMap<UnitKey, UnitKey>,
): string | null {
	const name = keys.join("+");
	const taken = keys.find((key) => grouped.has(key));
	if (taken !== undefined) return `"${taken}" already belongs to the merged unit "${grouped.get(taken)}"; "${name}" is ignored`;
	const missing = keys.find((key) => !sourceUnits.has(key) && !targetUnits.has(key));
	if (missing !== undefined) return `merged unit "${name}" names "${missing}", which is in neither note`;
	const units = keys.flatMap((key) => [sourceUnits.get(key), targetUnits.get(key)]).filter((u): u is KeyedUnit => u !== undefined);
	const whole = units.find((unit) => !isSentenceKind(unit.kind));
	if (whole !== undefined) return `merged unit "${name}" includes "${whole.key}", a ${whole.kind}, which aligns whole`;
	if (!keys.some((key) => sourceUnits.has(key)) || !keys.some((key) => targetUnits.has(key))) {
		return `merged unit "${name}" needs a paragraph in each note`;
	}
	return null;
}

/**
 * Source units in source order; each translation-only unit follows the
 * nearest paired unit before it in the translation. A merged unit stands
 * where its first block in the source stands.
 */
function orderUnits(sourceUnits: Map<UnitKey, KeyedUnit>, targetUnits: Map<UnitKey, KeyedUnit>, lines: AttachedLines): PairUnit[] {
	const leader = (key: UnitKey): UnitKey | undefined => lines.grouped.get(key);
	const followers = new Map<UnitKey | null, KeyedUnit[]>();
	let predecessor: UnitKey | null = null;
	for (const unit of targetUnits.values()) {
		const group = leader(unit.key);
		if (group !== undefined || sourceUnits.has(unit.key)) {
			predecessor = group ?? unit.key;
			continue;
		}
		const list = followers.get(predecessor) ?? [];
		list.push(unit);
		followers.set(predecessor, list);
	}
	const make = (key: UnitKey, kind: UnitKind): PairUnit => ({
		key,
		kind,
		source: sourceUnits.get(key)?.block ?? null,
		target: targetUnits.get(key)?.block ?? null,
		map: lines.maps.get(key) ?? null,
		pending: lines.pending.get(key) ?? null,
	});
	const merged = (first: UnitKey, keys: readonly UnitKey[]): PairUnit => {
		const blocks = (units: Map<UnitKey, KeyedUnit>): Block[] => keys.flatMap((key) => units.get(key)?.block ?? []);
		const source = blocks(sourceUnits);
		const target = blocks(targetUnits);
		return {
			key: first,
			kind: (source[0]?.kind ?? "paragraph") as UnitKind,
			source: source[0] ?? null,
			target: target[0] ?? null,
			map: lines.maps.get(first) ?? null,
			pending: lines.pending.get(first) ?? null,
			group: { keys, source, target },
		};
	};
	const ordered: PairUnit[] = [];
	const emitted = new Set<UnitKey>();
	const emitFollowers = (key: UnitKey | null): void => {
		for (const unit of followers.get(key) ?? []) ordered.push(make(unit.key, unit.kind));
	};
	emitFollowers(null);
	for (const unit of sourceUnits.values()) {
		const group = leader(unit.key);
		if (group === undefined) ordered.push(make(unit.key, unit.kind));
		else if (!emitted.has(group)) {
			emitted.add(group);
			ordered.push(merged(group, lines.groups.get(group) ?? [group]));
		} else continue;
		emitFollowers(group ?? unit.key);
	}
	return ordered;
}

/** Lines from a block's first line through its own-line id, if any. */
function blockLines(block: Block): LineRange {
	const end = block.idStyle === "own-line" && block.idLine !== null ? Math.max(block.lines.end, block.idLine + 1) : block.lines.end;
	return { start: block.lines.start, end };
}

function indexLines(units: readonly PairUnit[], side: Side, mapLines: Map<UnitKey, number>): Map<number, PairUnit> {
	const index = new Map<number, PairUnit>();
	for (const unit of units) {
		const covered: number[] = [];
		for (const block of unitBlocks(unit, side)) {
			for (let line = block.lines.start; line < block.lines.end; line++) covered.push(line);
			if (block.idStyle === "own-line" && block.idLine !== null) covered.push(block.idLine);
		}
		const mapLine = side === "target" ? mapLines.get(unit.key) : undefined;
		if (mapLine !== undefined) covered.push(mapLine);
		for (const line of covered) if (!index.has(line)) index.set(line, unit);
	}
	return index;
}

function computeStops(units: readonly PairUnit[]): CursorStop[] {
	const stops: CursorStop[] = [];
	for (const unit of units) {
		if (unit.source === null || unit.kind === "footnote" || unit.kind === "heading") continue;
		const linkStops = (unit.map?.links ?? []).flatMap((link, i) => (link.src === null ? [] : [{ unit: unit.key, link: i + 1 }]));
		if (unit.target !== null && linkStops.length > 0) stops.push(...linkStops);
		else stops.push({ unit: unit.key, link: null });
	}
	return stops;
}

function computeAnchors(units: readonly PairUnit[]): ScrollAnchor[] {
	return units.flatMap((unit) => {
		const source = spanLines(unitBlocks(unit, "source"));
		const target = spanLines(unitBlocks(unit, "target"));
		return source === null || target === null ? [] : [{ key: unit.key, source, target }];
	});
}

/** From the first block's first line through the last block's last line (or own-line id). */
function spanLines(blocks: readonly Block[]): LineRange | null {
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	return first === undefined || last === undefined ? null : { start: first.lines.start, end: blockLines(last).end };
}
