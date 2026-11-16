/**
 * Pairs the units of two notes for the align command: sections by heading
 * order, units within a section by dynamic programming or by a supplied
 * content-based pairing. Pure.
 * Owner: align module. DESIGN.md §7.2.
 */
import type { Block, UnitKey, UnitMatch } from "../types";
import { footnoteKey } from "./model";
import { wordsOf } from "./words";

/** Features of one unit used by the matcher. */
export interface MatchItem {
	kind: Block["kind"];
	/** Index of the governing heading in the text region; -1 before the first. */
	section: number;
	words: number;
	/** Language-neutral anchors: digit runs, footnote keys, capitalized tokens longer than 3 letters. */
	anchors: readonly string[];
	/** Footnotes only: footnoteKey of the label. Footnotes pair by it, not by position. */
	footnote?: UnitKey;
}

/** Cost of leaving one unit unpaired. */
const SKIP_COST = 1.5;
/** Added to a 1-1 move whose kinds differ (other than quote against paragraph, which never pairs). */
const KIND_PENALTY = 2;
/** Subtracted, scaled by the Jaccard overlap of the two anchor sets. */
const ANCHOR_BONUS = 1;
/** A chosen move costing more than this (before any merge penalty) is shown to the user as doubtful. */
const DOUBTFUL_COST = 1;
/** Added to a 2-1 or 1-2 move, so that two units merge only when that fits clearly better than pairing one and skipping the other. */
const MERGE_PENALTY = 1;
/** Kinds that may merge: those with sentence maps. */
const SENTENCE_KINDS: ReadonlySet<Block["kind"]> = new Set(["paragraph", "quote", "callout"]);

const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
const DIGIT_RUN_RE = /\p{Nd}+/gu;
const CAPITALIZED_RE = /^\p{Lu}/u;

/** Builds a MatchItem from a unit and its projected text. */
export function matchItem(block: Block, projectedText: string, section: number): MatchItem {
	const words = wordsOf(projectedText);
	const anchors = new Set<string>();
	for (const match of projectedText.matchAll(DIGIT_RUN_RE)) anchors.add(match[0]);
	for (const match of block.raw.matchAll(FOOTNOTE_REF_RE)) anchors.add(footnoteKey(match[1] as string));
	for (const word of words) {
		const surface = projectedText.slice(word.start, word.end);
		if (CAPITALIZED_RE.test(surface) && word.norm.length > 3) anchors.add(word.norm);
	}
	const item: MatchItem = { kind: block.kind, section, words: words.length, anchors: [...anchors].sort() };
	if (block.kind === "footnote" && block.footnoteLabel !== undefined) item.footnote = footnoteKey(block.footnoteLabel);
	return item;
}

/** Pairs of one section, as indices into the full item lists; units in none are unpaired. */
export type SectionPairs = readonly { source: readonly number[]; target: readonly number[] }[];

/**
 * Pairs a section's units another way (the align job asks Claude, §7.2):
 * given the section's source and target item indices, the pairs, or null
 * to keep the dynamic program's.
 */
export type SectionPairer = (source: readonly number[], target: readonly number[]) => SectionPairs | null;

/**
 * Footnotes pair by key across the whole note (the first of a repeated key
 * wins); a footnote without a key stays unpaired. Other units: monotone
 * pairing with moves 1-1, 2-1, 1-2, 1-0, 0-1. Identical kind sequences per
 * section yield the diagonal; moves above the cost threshold are doubtful.
 * Sections pair in heading order, under the shift of heading numbers that
 * costs least: a title or preface heading that only one note has shifts
 * every later section by one. Units of a section missing on the other side
 * stay unpaired. `pairer` may then replace the pairing of any section that
 * has units on both sides.
 */
export function matchUnits(source: readonly MatchItem[], target: readonly MatchItem[], pairer?: SectionPairer): UnitMatch {
	const result: MatchOut = { pairs: [], sourceOnly: [], targetOnly: [] };
	matchFootnotes(source, target, result);
	const best = bestShift(source, target);
	if (best !== null) {
		const chosen = pairer === undefined ? best.match : matchShifted(source, target, best.sections, pairer);
		result.pairs.push(...chosen.pairs);
		result.sourceOnly.push(...chosen.sourceOnly);
		result.targetOnly.push(...chosen.targetOnly);
	}
	result.pairs.sort((a, b) => (a.source[0] ?? 0) - (b.source[0] ?? 0));
	result.sourceOnly.sort((a, b) => a - b);
	result.targetOnly.sort((a, b) => a - b);
	return result;
}

/**
 * The section pairs matchUnits would use: for each, the source and target
 * item indices, footnotes left out. A section with units on only one side
 * has an empty list on the other.
 */
export function matchSections(source: readonly MatchItem[], target: readonly MatchItem[]): { source: number[]; target: number[] }[] {
	return bestShift(source, target)?.sections ?? [];
}

/** True when a section's units pair down the diagonal without asking: same count, same kinds in order. */
export function isDiagonal(source: readonly MatchItem[], target: readonly MatchItem[], src: readonly number[], tgt: readonly number[]): boolean {
	return src.length === tgt.length && src.every((i, k) => (source[i] as MatchItem).kind === (target[tgt[k] as number] as MatchItem).kind);
}

type Move = "pair" | "skipSource" | "skipTarget" | "mergeSource" | "mergeTarget";
type Pair = UnitMatch["pairs"][number];
type MatchOut = { pairs: Pair[]; sourceOnly: number[]; targetOnly: number[] };
type SectionMatch = MatchOut & { cost: number };
type Sections = { source: number[]; target: number[] }[];

/** Below this, two candidate costs count as equal, and the smaller shift wins. */
const COST_EPSILON = 1e-9;

function bestShift(source: readonly MatchItem[], target: readonly MatchItem[]): { sections: Sections; match: SectionMatch } | null {
	const sourceSections = groupBySection(source);
	const targetSections = groupBySection(target);
	let best: { sections: Sections; match: SectionMatch } | null = null;
	for (const shift of sectionShifts([...sourceSections.keys()], [...targetSections.keys()])) {
		const sections = shiftedSections(sourceSections, targetSections, shift);
		const match = matchShifted(source, target, sections);
		if (best === null || match.cost < best.match.cost - COST_EPSILON) best = { sections, match };
	}
	return best;
}

/** Every target-minus-source section number difference, smallest first; 0 always comes first. */
function sectionShifts(sourceSections: readonly number[], targetSections: readonly number[]): number[] {
	const shifts = new Set([0]);
	for (const s of sourceSections) for (const t of targetSections) shifts.add(t - s);
	return [...shifts].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

/** Source section s against target section s + shift, in order of s. */
function shiftedSections(sourceSections: ReadonlyMap<number, number[]>, targetSections: ReadonlyMap<number, number[]>, shift: number): Sections {
	const numbers = [...new Set([...sourceSections.keys(), ...[...targetSections.keys()].map((t) => t - shift)])].sort((a, b) => a - b);
	return numbers.map((n) => ({ source: sourceSections.get(n) ?? [], target: targetSections.get(n + shift) ?? [] }));
}

/** Pairs each section pair; every other unit is left unpaired at the skip cost. */
function matchShifted(source: readonly MatchItem[], target: readonly MatchItem[], sections: Sections, pairer?: SectionPairer): SectionMatch {
	const out: SectionMatch = { pairs: [], sourceOnly: [], targetOnly: [], cost: 0 };
	for (const section of sections) {
		const asked = pairer && section.source.length > 0 && section.target.length > 0 ? pairer(section.source, section.target) : null;
		const part = asked ? fromPairs(section, asked) : matchSection(source, target, section.source, section.target);
		out.pairs.push(...part.pairs);
		out.sourceOnly.push(...part.sourceOnly);
		out.targetOnly.push(...part.targetOnly);
		out.cost += part.cost;
	}
	return out;
}

/** A section's match from given pairs: units in no pair are unpaired. */
function fromPairs(section: Sections[number], pairs: SectionPairs): SectionMatch {
	const pairedSource = new Set(pairs.flatMap((p) => p.source));
	const pairedTarget = new Set(pairs.flatMap((p) => p.target));
	return {
		pairs: pairs.map((p) => ({ source: [...p.source], target: [...p.target], doubtful: false })),
		sourceOnly: section.source.filter((i) => !pairedSource.has(i)),
		targetOnly: section.target.filter((j) => !pairedTarget.has(j)),
		cost: 0,
	};
}

function matchFootnotes(source: readonly MatchItem[], target: readonly MatchItem[], out: MatchOut): void {
	const targetByKey = new Map<UnitKey, number>();
	target.forEach((item, j) => {
		if (item.kind === "footnote" && item.footnote !== undefined && !targetByKey.has(item.footnote)) targetByKey.set(item.footnote, j);
	});
	const pairedTargets = new Set<number>();
	source.forEach((item, i) => {
		if (item.kind !== "footnote") return;
		const j = item.footnote === undefined ? undefined : targetByKey.get(item.footnote);
		if (j === undefined || pairedTargets.has(j)) {
			out.sourceOnly.push(i);
			return;
		}
		pairedTargets.add(j);
		out.pairs.push({ source: [i], target: [j], doubtful: false });
	});
	target.forEach((item, j) => {
		if (item.kind === "footnote" && !pairedTargets.has(j)) out.targetOnly.push(j);
	});
}

/** The cheapest monotone pairing of one section pair, with its cost. */
function matchSection(source: readonly MatchItem[], target: readonly MatchItem[], src: readonly number[], tgt: readonly number[]): SectionMatch {
	const out: SectionMatch = { pairs: [], sourceOnly: [], targetOnly: [], cost: 0 };
	const median = medianLogRatio(src.map((i) => (source[i] as MatchItem).words), tgt.map((j) => (target[j] as MatchItem).words));
	const srcItem = (i: number): MatchItem => source[src[i] as number] as MatchItem;
	const tgtItem = (j: number): MatchItem => target[tgt[j] as number] as MatchItem;
	const pairCost = (i: number, j: number): number => moveCost(srcItem(i), tgtItem(j), median);
	/** Two units against one: source i-1, i against target j, or target j-1, j against source i. */
	const mergeCost = (i: number, j: number, side: "source" | "target"): number => {
		const [a, b, other] = side === "source" ? [srcItem(i - 1), srcItem(i), tgtItem(j)] : [tgtItem(j - 1), tgtItem(j), srcItem(i)];
		if (!SENTENCE_KINDS.has(a.kind) || a.kind !== b.kind || a.kind !== other.kind) return Infinity;
		const merged = { ...a, words: a.words + b.words, anchors: [...new Set([...a.anchors, ...b.anchors])] };
		return (side === "source" ? moveCost(merged, other, median) : moveCost(other, merged, median)) + MERGE_PENALTY;
	};

	if (isDiagonal(source, target, src, tgt)) {
		src.forEach((i, k) => {
			const cost = pairCost(k, k);
			out.pairs.push({ source: [i], target: [tgt[k] as number], doubtful: cost > DOUBTFUL_COST });
			out.cost += cost;
		});
		return out;
	}

	const n = src.length;
	const m = tgt.length;
	const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
	const move: Move[][] = Array.from({ length: n + 1 }, () => new Array<Move>(m + 1).fill("pair"));
	(cost[0] as number[])[0] = 0;
	const at = (i: number, j: number): number => (cost[i] as number[])[j] as number;
	for (let i = 0; i <= n; i++) {
		for (let j = 0; j <= m; j++) {
			if (i === 0 && j === 0) continue;
			let best = Infinity;
			let bestMove: Move = "pair";
			const consider = (value: number, step: Move): void => {
				if (value < best) [best, bestMove] = [value, step];
			};
			if (i > 0 && j > 0) consider(at(i - 1, j - 1) + pairCost(i - 1, j - 1), "pair");
			if (i > 0) consider(at(i - 1, j) + SKIP_COST, "skipSource");
			if (j > 0) consider(at(i, j - 1) + SKIP_COST, "skipTarget");
			if (i > 1 && j > 0) consider(at(i - 2, j - 1) + mergeCost(i - 1, j - 1, "source"), "mergeSource");
			if (i > 0 && j > 1) consider(at(i - 1, j - 2) + mergeCost(i - 1, j - 1, "target"), "mergeTarget");
			(cost[i] as number[])[j] = best;
			(move[i] as Move[])[j] = bestMove;
		}
	}
	out.cost = at(n, m);
	for (let i = n, j = m; i > 0 || j > 0; ) {
		const step = (move[i] as Move[])[j];
		if (step === "pair") {
			out.pairs.push({ source: [src[i - 1] as number], target: [tgt[j - 1] as number], doubtful: pairCost(i - 1, j - 1) > DOUBTFUL_COST });
			i--;
			j--;
		} else if (step === "mergeSource") {
			const doubtful = mergeCost(i - 1, j - 1, "source") - MERGE_PENALTY > DOUBTFUL_COST;
			out.pairs.push({ source: [src[i - 2] as number, src[i - 1] as number], target: [tgt[j - 1] as number], doubtful });
			i -= 2;
			j--;
		} else if (step === "mergeTarget") {
			const doubtful = mergeCost(i - 1, j - 1, "target") - MERGE_PENALTY > DOUBTFUL_COST;
			out.pairs.push({ source: [src[i - 1] as number], target: [tgt[j - 2] as number, tgt[j - 1] as number], doubtful });
			i--;
			j -= 2;
		} else if (step === "skipSource") {
			out.sourceOnly.push(src[--i] as number);
		} else {
			out.targetOnly.push(tgt[--j] as number);
		}
	}
	return out;
}

function moveCost(a: MatchItem, b: MatchItem, medianRatio: number): number {
	let cost = 0;
	if (a.kind !== b.kind) {
		if (isQuoteAgainstParagraph(a.kind, b.kind)) return Infinity;
		cost += KIND_PENALTY;
	}
	cost += Math.abs(logRatio(a.words, b.words) - medianRatio);
	return cost - ANCHOR_BONUS * jaccard(a.anchors, b.anchors);
}

function isQuoteAgainstParagraph(a: Block["kind"], b: Block["kind"]): boolean {
	return (a === "quote" && b === "paragraph") || (a === "paragraph" && b === "quote");
}

/** ln of the target/source length ratio, smoothed so empty units stay finite. */
function logRatio(sourceWords: number, targetWords: number): number {
	return Math.log((targetWords + 1) / (sourceWords + 1));
}

/**
 * The section's typical length ratio, estimated from the median unit length
 * on each side so one unpaired unit does not shift it.
 */
function medianLogRatio(sourceWords: readonly number[], targetWords: readonly number[]): number {
	if (sourceWords.length === 0 || targetWords.length === 0) return 0;
	return logRatio(median(sourceWords), median(targetWords));
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	const setB = new Set(b);
	const shared = a.filter((x) => setB.has(x)).length;
	return shared / (a.length + b.length - shared);
}

/** Indices of the non-footnote items, grouped by section. */
function groupBySection(items: readonly MatchItem[]): Map<number, number[]> {
	const sections = new Map<number, number[]>();
	items.forEach((item, index) => {
		if (item.kind === "footnote") return;
		const group = sections.get(item.section) ?? [];
		group.push(index);
		sections.set(item.section, group);
	});
	return sections;
}
