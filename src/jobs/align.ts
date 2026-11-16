/**
 * Align with existing translation: match units, preview, write ids and
 * `align` markers, then one sentence-matching task per marker. Never
 * changes a word of either note. Owner: jobs module. DESIGN.md §7.2.
 */
import type { TFile } from "obsidian";
import { linksFromRanges, parseMenardLine, serializeMenardLine } from "../align/map";
import { isDiagonal, matchItem, matchSections, matchUnits } from "../align/match";
import type { MatchItem, SectionPairer, SectionPairs } from "../align/match";
import { wordsOf } from "../align/words";
import { FM } from "../constants";
import { MenardError } from "../errors";
import { alignPrompt, pairingPrompt } from "../llm/prompts";
import { validateAlign, validatePairing } from "../llm/validate";
import { parseOptions } from "../settings";
import { parseNote, textUnits } from "../text/blocks";
import { lineStarts, locateMenardLines } from "../text/edits";
import { allocateIds, idInserts } from "../text/ids";
import { projectMarkdown } from "../text/inline";
import { segmentSentences } from "../text/segment";
import type {
	AlignGroup,
	Block,
	CharRange,
	Insert,
	MapLink,
	MenardLine,
	MenardSettings,
	NoteStructure,
	PairingUnit,
	PairLanguages,
	PairLink,
	ParseOptions,
	UnitKey,
	WordRange,
} from "../types";
import { rulesFor, wordRangeOf } from "./assemble";
import type { JobDeps } from "./controller";
import { uiOf } from "./modals";
import type { AlignSummary } from "./modals";
import {
	callValidated,
	facingAction,
	keyedUnits,
	lineInsertAfter,
	linkPair,
	linkedNote,
	pairLanguages,
	parseTarget,
	pendingMarkers,
	replaceMarker,
	requireClaude,
	runQueued,
	segmentBase,
	summarize,
} from "./translate";

const ALIGN_WORDS = { done: "Aligned", gerund: "Alignment", command: "Align with existing translation" };
/** Words of each side shown for a doubtful pair in the preview. */
const PREVIEW_WORDS = 6;
/** Words from the start, and from the end of a longer unit, shown to Claude for paragraph pairing. */
const EXCERPT_HEAD = 40;
const EXCERPT_TAIL = 10;
/** A unit with more words than this on either side is never accepted as one loose link (#36): it is flagged instead. */
const LOOSE_WHOLE_MAX_WORDS = 40;
const SENTENCE_KINDS: ReadonlySet<Block["kind"]> = new Set<Block["kind"]>(["paragraph", "quote", "callout"]);

export async function runAlign(deps: JobDeps, source: TFile, target: TFile | null, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	const options = parseOptions(settings);
	const { vault } = deps.ctx.app;
	if (!(await requireClaude(deps, ui))) return;
	if (target === null && deps.pairs.resolve(source)?.side === "target") {
		ui.notice("This is a translation note. Run Align with existing translation on its source.");
		return;
	}
	const partner = target ?? deps.pairs.resolve(source)?.pair.target ?? linkedNote(deps, source, FM.translation) ?? (await ui.pickNote(source));
	if (partner === null) return;
	const refusal = partnerRefusal(deps, source, partner);
	if (refusal !== null) {
		ui.explain("Align with existing translation", refusal);
		return;
	}

	const [sourceText, targetText] = await Promise.all([vault.read(source), vault.read(partner)]);
	const languages = pairLanguages(deps, partner, settings);
	const pairer = await askPairings(deps, { source: sourceText, target: targetText }, options, languages, controller);
	if (controller.signal.aborted) return;
	const plan = planAlign(sourceText, targetText, options, pairer);
	if (plan.summary.paired === 0 && pendingMarkers(targetText, "align").length === 0) {
		ui.notice("No paragraphs of the two notes could be paired.");
		return;
	}
	if (!(await ui.confirmAlign(plan.summary))) return;

	// Both notes are checked before either is written, so an edit made during the preview leaves neither half-written.
	// The source goes first: if the translation's write then fails, running Align again completes it exactly (#33, DESIGN.md §7.2).
	const [sourceNow, targetNow] = await Promise.all([vault.read(source), vault.read(partner)]);
	if (sourceNow !== sourceText || targetNow !== targetText) throw new MenardError("write-conflict", "A note changed while the preview was open.");
	for (const [file, original, inserts] of [
		[source, sourceText, plan.sourceInserts],
		[partner, targetText, plan.targetInserts],
	] as const) {
		const outcome = await deps.writer.insert(file, (text) => (text !== original ? "conflict" : inserts.length === 0 ? "noop" : inserts));
		if (!outcome.ok) throw outcome.error;
	}
	await linkPair(deps, source, partner);
	await addLanguages(deps, partner, settings);
	await runAlignMarkers(deps, { source, target: partner }, null, controller);
}

/**
 * The sentence pass: one task per `align` marker (only those of `keys`
 * when given), each replacing its marker with a map built from Claude's
 * sentence groups.
 */
export async function runAlignMarkers(deps: JobDeps, pair: PairLink, keys: readonly UnitKey[] | null, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	const languages = pairLanguages(deps, pair.target, settings);
	const markers = pendingMarkers(await deps.ctx.app.vault.read(pair.target), "align").filter((key) => keys === null || keys.includes(key));
	const tasks = markers.map((key) => ({ key, run: (signal: AbortSignal) => alignMarker(deps, pair, languages, key, signal) }));
	const run = await runQueued(deps, ui, `Aligning ${pair.source.basename}`, tasks, controller);
	run.progress.finish(summarize(run.report, tasks.length, ALIGN_WORDS), facingAction(deps, run.report, pair.source));
}

/**
 * Prepares a re-alignment: each key's map becomes an `align` marker, and a
 * paired sentence unit with neither map nor marker gets one after its
 * translation. Markers already waiting are left as they are.
 */
export async function requestRealign(deps: JobDeps, pair: PairLink, keys: readonly UnitKey[]): Promise<void> {
	const options = parseOptions(deps.ctx.settings());
	const wanted = new Set(keys);
	const rewrite = await deps.writer.rewriteOwned(pair.target, (text) => {
		const replacements = locateMenardLines(text).flatMap((line) => {
			const parsed = parseMenardLine(line.raw);
			if ("error" in parsed || parsed.kind !== "map" || !wanted.has(parsed.key)) return [];
			const marker = serializeMenardLine({ kind: "marker", key: parsed.key, ...groupOf(parsed), task: "align" });
			return [{ from: line.from, to: line.to, expect: line.raw, text: marker }];
		});
		return replacements.length === 0 ? "noop" : replacements;
	});
	if (!rewrite.ok) throw rewrite.error;
	const insert = await deps.writer.insert(pair.target, (text) => {
		const lined = new Set(locateMenardLines(text).flatMap((line) => line.keys));
		const starts = lineStarts(text);
		const inserts = keyedUnits(parseTarget(text, options)).flatMap(({ key, block }): Insert[] =>
			wanted.has(key) && !lined.has(key) && SENTENCE_KINDS.has(block.kind) ? [markerAfter(text, starts, block, [key], false)] : [],
		);
		return inserts.length === 0 ? "noop" : inserts;
	});
	if (!insert.ok) throw insert.error;
}

/** Why `partner` cannot become the translation of `source`, or null. */
function partnerRefusal(deps: JobDeps, source: TFile, partner: TFile): string | null {
	if (partner === source) return "A note cannot be aligned with itself. Choose its translation note.";
	if (linkedNote(deps, partner, FM.translation) !== null) return `“${partner.basename}” is the source of another pair, so it cannot be this note's translation.`;
	const partnerSource = linkedNote(deps, partner, FM.source);
	if (partnerSource !== null && partnerSource !== source) return `“${partner.basename}” is already the translation of “${partnerSource.basename}”.`;
	const current = linkedNote(deps, source, FM.translation);
	if (current !== null && current !== partner) return `This note already links to the translation “${current.basename}”. Remove that link first to pair it with another note.`;
	return null;
}

async function alignMarker(deps: JobDeps, pair: PairLink, languages: PairLanguages, key: UnitKey, signal: AbortSignal): Promise<void> {
	const options = parseOptions(deps.ctx.settings());
	const { vault } = deps.ctx.app;
	const [sourceText, targetText] = await Promise.all([vault.read(pair.source), vault.read(pair.target)]);
	const marker = findMarker(targetText, key, "align");
	const keys = marker?.group ?? [key];
	const blocksOf = (note: NoteStructure): Block[] => {
		const byKey = new Map(keyedUnits(note).map((unit) => [unit.key, unit.block]));
		return keys.flatMap((k) => byKey.get(k) ?? []);
	};
	const sources = blocksOf(parseNote(sourceText, options));
	const targets = blocksOf(parseTarget(targetText, options));
	if (sources.length === 0 || targets.length === 0) throw new Error(`Unit ${keys.join("+")} is missing from one of the notes.`);
	const links = await alignUnit(deps, languages, key, sources, targets, signal);
	await replaceMarker(deps, pair.target, key, "align", serializeMenardLine({ kind: "map", key, ...(marker ? groupOf(marker) : {}), links }));
}

/** The pending marker of `key` and `task` in `text`, parsed. */
function findMarker(text: string, key: UnitKey, task: "translate" | "align"): Extract<MenardLine, { kind: "marker" }> | null {
	for (const line of locateMenardLines(text)) {
		const parsed = parseMenardLine(line.raw);
		if (!("error" in parsed) && parsed.kind === "marker" && parsed.key === key && parsed.task === task) return parsed;
	}
	return null;
}

/** `{ group }` for a line naming a key group, else nothing, for spreading into a new line. */
function groupOf(line: Pick<MenardLine, "group">): { group?: readonly UnitKey[] } {
	return line.group === undefined ? {} : { group: line.group };
}

/** A unit side cut into sentences: their projection texts and word ranges. Several blocks (a merged unit) read in order. */
interface SentenceSide {
	texts: string[];
	words: ReturnType<typeof wordsOf>;
	ranges: WordRange[];
}

function sentenceSide(blocks: readonly Block[], settings: MenardSettings, lang: string): SentenceSide {
	const texts: string[] = [];
	const chars: CharRange[] = [];
	let joined = "";
	for (const block of blocks) {
		if (joined !== "") joined += "\n\n";
		const offset = joined.length;
		const projection = projectMarkdown(block.body);
		for (const range of segmentSentences(projection, rulesFor(block, segmentBase(settings, lang)))) {
			texts.push(projection.text.slice(range.start, range.end).trim());
			chars.push({ start: range.start + offset, end: range.end + offset });
		}
		joined += projection.text;
	}
	const words = wordsOf(joined);
	return { texts, words, ranges: chars.map((range) => wordRangeOf(words, range.start, range.end)) };
}

/**
 * The sentence map of one unit pair: Claude groups the sentences; counts and
 * hashes come from the words. A single loose link over a long unit is not
 * trusted: both sides are flagged instead (#36).
 */
async function alignUnit(
	deps: JobDeps,
	languages: PairLanguages,
	key: UnitKey,
	sourceBlocks: readonly Block[],
	targetBlocks: readonly Block[],
	signal: AbortSignal,
): Promise<MapLink[]> {
	const settings = deps.ctx.settings();
	const source = sentenceSide(sourceBlocks, settings, languages.source);
	const target = sentenceSide(targetBlocks, settings, languages.target);
	if (source.words.length === 0 || target.words.length === 0) throw new Error(`Unit ${key} has no words on one side.`);
	let groups: readonly AlignGroup[] = [{ src: [1], tgt: [1], loose: false }];
	if (source.texts.length > 1 || target.texts.length > 1) {
		const input = { key, languages, source: source.texts, target: target.texts };
		const output = await callValidated(
			deps,
			(retryErrors) => alignPrompt(retryErrors ? { ...input, retryErrors } : input),
			(raw) => validateAlign(input, raw),
			signal,
		);
		groups = output.groups;
	}
	const only = groups.length === 1 ? groups[0] : undefined;
	if (only?.loose && Math.max(source.words.length, target.words.length) > LOOSE_WHOLE_MAX_WORDS) {
		groups = [
			{ src: only.src, tgt: [], loose: false },
			{ src: [], tgt: only.tgt, loose: false },
		];
	}
	return linksFromRanges(
		{ words: source.words, ranges: groupRanges(groups.map((g) => g.src), source.ranges) },
		{ words: target.words, ranges: groupRanges(groups.map((g) => g.tgt), target.ranges) },
		groups.map((group) => group.loose),
	);
}

/** Word ranges of each group's sentences; an empty group is an empty range where the side stands. */
function groupRanges(groups: readonly (readonly number[])[], sentences: readonly WordRange[]): WordRange[] {
	let cursor = 0;
	return groups.map((numbers) => {
		const first = numbers[0];
		const last = numbers[numbers.length - 1];
		if (first === undefined || last === undefined) return { start: cursor, end: cursor };
		const range = { start: sentences[first - 1]?.start ?? cursor, end: sentences[last - 1]?.end ?? cursor };
		cursor = range.end;
		return range;
	});
}

async function addLanguages(deps: JobDeps, target: TFile, settings: MenardSettings): Promise<void> {
	const frontmatter = deps.ctx.app.metadataCache.getFileCache(target)?.frontmatter ?? {};
	const missing: Record<string, string> = {};
	if (frontmatter[FM.sourceLanguage] === undefined) missing[FM.sourceLanguage] = settings.defaultSourceLanguage;
	if (frontmatter[FM.targetLanguage] === undefined) missing[FM.targetLanguage] = settings.defaultTargetLanguage;
	if (Object.keys(missing).length > 0) await deps.writer.setFrontmatter(target, missing);
}

// ─── Planning ───────────────────────────────────────────────────────────────

export interface AlignPlan {
	summary: AlignSummary;
	/** Insert-only edits of the source: ids. */
	sourceInserts: Insert[];
	/** Insert-only edits of the translation: ids, then `align` markers. */
	targetInserts: Insert[];
}

/**
 * Matches both notes' units and plans the ids and markers. A user id on
 * either side becomes the pair key on both; a pair whose blocks already
 * carry different ids, or whose id the other note uses elsewhere, cannot be
 * keyed (a block holds one id) and is left unpaired. Pure.
 */
export function planAlign(sourceText: string, targetText: string, options: ParseOptions, pairer?: SectionPairer): AlignPlan {
	const sourceNote = parseNote(sourceText, options);
	const targetNote = parseTarget(targetText, options);
	const sourceUnits = matchable(sourceNote);
	const targetUnits = matchable(targetNote);
	const match = matchUnits(sourceUnits.map((u) => u.item), targetUnits.map((u) => u.item), pairer);

	const reserved = new Set([...sourceNote.usedIds, ...targetNote.usedIds]);
	const sourceIds: { block: Block; id: string }[] = [];
	const targetIds: { block: Block; id: string }[] = [];
	/**
	 * Blocks still needing an id, in pair order; a pair's two first blocks share one slot.
	 * `targetOnly` slots are numbered after all others (#33): the source is written first,
	 * so a rerun after a failed translation write numbers them exactly as this run does.
	 */
	const fresh: { targetOnly: boolean; assign: (id: string) => void }[] = [];
	const keyed: { keys: (UnitKey | null)[]; sources: Block[]; targets: Block[]; doubtful: boolean }[] = [];
	let unkeyable = 0;
	let dropped = { source: 0, target: 0 };
	for (const pair of match.pairs) {
		let sources = pair.source.flatMap((i) => sourceUnits[i]?.block ?? []);
		let targets = pair.target.flatMap((j) => targetUnits[j]?.block ?? []);
		const [source] = sources;
		const [target] = targets;
		if (source === undefined || target === undefined) continue;
		let key: UnitKey | null = null;
		let needsFresh = false;
		if (source.id !== null && target.id !== null) key = source.id === target.id ? source.id : null;
		else if (source.id !== null) key = targetNote.usedIds.has(source.id) ? null : source.id;
		else if (target.id !== null) key = sourceNote.usedIds.has(target.id) ? null : target.id;
		else needsFresh = true;
		if (key === null && !needsFresh) {
			unkeyable++;
			dropped = { source: dropped.source + sources.length - 1, target: dropped.target + targets.length - 1 };
			continue;
		}
		// A merged block keeps its own id, which the other note must not use (it would pair there); else the merge is dropped.
		const extras = [...sources.slice(1).map((block) => ({ block, other: targetNote })), ...targets.slice(1).map((block) => ({ block, other: sourceNote }))];
		if (extras.some(({ block, other }) => block.id !== null && other.usedIds.has(block.id))) {
			dropped = { source: dropped.source + sources.length - 1, target: dropped.target + targets.length - 1 };
			sources = [source];
			targets = [target];
		}
		const entry = { keys: [key, ...[...sources.slice(1), ...targets.slice(1)].map((block) => block.id)], sources, targets, doubtful: pair.doubtful };
		keyed.push(entry);
		if (needsFresh) {
			fresh.push({
				targetOnly: false,
				assign: (id) => {
					entry.keys[0] = id;
					sourceIds.push({ block: source, id });
					targetIds.push({ block: target, id });
				},
			});
		} else {
			if (source.id === null) sourceIds.push({ block: source, id: key as UnitKey });
			if (target.id === null) targetIds.push({ block: target, id: key as UnitKey });
		}
		[...sources.slice(1), ...targets.slice(1)].forEach((block, k) => {
			if (block.id !== null) return;
			const onSource = sources.includes(block);
			const ids = onSource ? sourceIds : targetIds;
			fresh.push({
				targetOnly: !onSource,
				assign: (id) => {
					entry.keys[k + 1] = id;
					ids.push({ block, id });
				},
			});
		});
	}
	const ids = allocateIds(sourceNote, fresh.length, reserved);
	[...fresh.filter((slot) => !slot.targetOnly), ...fresh.filter((slot) => slot.targetOnly)].forEach((slot, i) => slot.assign(ids[i] as string));

	const lined = new Set(locateMenardLines(targetText).flatMap((line) => line.keys));
	const starts = lineStarts(targetText);
	const markers = keyed.flatMap(({ keys, sources, targets }) => {
		const last = targets[targets.length - 1] as Block;
		const all = [...sources, ...targets];
		if (keys.some((k) => k === null || lined.has(k)) || !all.every((block) => SENTENCE_KINDS.has(block.kind))) return [];
		return [markerAfter(targetText, starts, last, keys as UnitKey[], last.id === null && last.kind !== "paragraph")];
	});
	const sections = new Set([...sourceUnits, ...targetUnits].map((u) => u.item.section));
	const words = (blocks: readonly Block[]): string => blocks.map(firstWords).join(" + ");
	return {
		summary: {
			sections: sections.size,
			paired: keyed.length,
			sourceOnly: match.sourceOnly.length + unkeyable + dropped.source,
			targetOnly: match.targetOnly.length + unkeyable + dropped.target,
			doubtful: keyed.filter((k) => k.doubtful).map((k) => `${words(k.sources)} / ${words(k.targets)}`),
			merged: keyed.filter((k) => k.sources.length + k.targets.length > 2).map((k) => `${words(k.sources)} / ${words(k.targets)}`),
		},
		sourceInserts: sourceIds.length === 0 ? [] : idInserts(sourceText, sourceNote, sourceIds),
		targetInserts: [...(targetIds.length === 0 ? [] : idInserts(targetText, targetNote, targetIds)), ...markers],
	};
}

/**
 * Content-based paragraph pairing (§7.2, #36): one Claude call per section
 * whose units are not the plain diagonal, given an excerpt of each unit.
 * A section whose call fails keeps the dynamic program's pairing; so does
 * every section when the job is cancelled.
 */
async function askPairings(
	deps: JobDeps,
	texts: { source: string; target: string },
	options: ParseOptions,
	languages: PairLanguages,
	controller: AbortController,
): Promise<SectionPairer> {
	const sourceUnits = matchable(parseNote(texts.source, options));
	const targetUnits = matchable(parseTarget(texts.target, options));
	const src = sourceUnits.map((u) => u.item);
	const tgt = targetUnits.map((u) => u.item);
	const sections = matchSections(src, tgt).filter((s) => s.source.length > 0 && s.target.length > 0 && !isDiagonal(src, tgt, s.source, s.target));
	const answers = new Map<string, SectionPairs>();
	if (sections.length === 0) return () => null;

	const ui = uiOf(deps);
	const progress = ui.progress("Pairing paragraphs by content", () => controller.abort());
	let done = 0;
	let failed = 0;
	for (const section of sections) {
		if (controller.signal.aborted) break;
		progress.update(done, 0, 1, sections.length);
		const input = {
			languages,
			source: section.source.map((i) => pairingUnit(sourceUnits[i]?.block as Block)),
			target: section.target.map((j) => pairingUnit(targetUnits[j]?.block as Block)),
		};
		try {
			const output = await callValidated(
				deps,
				(retryErrors) => pairingPrompt(retryErrors ? { ...input, retryErrors } : input),
				(raw) => validatePairing(input, raw),
				controller.signal,
			);
			const pairs = output.groups
				.filter((group) => group.src.length > 0 && group.tgt.length > 0)
				.map((group) => ({ source: group.src.map((n) => section.source[n - 1] as number), target: group.tgt.map((n) => section.target[n - 1] as number) }));
			answers.set(sectionKey(section.source, section.target), pairs);
		} catch {
			// The dynamic program pairs this section instead.
			failed++;
		}
		done++;
	}
	progress.close();
	if (failed > 0 && !controller.signal.aborted) {
		ui.notice(`Claude could not pair the paragraphs of ${failed === 1 ? "one section" : `${failed} sections`} by content; they were paired by length. Check the preview.`);
	}
	return (source, target) => answers.get(sectionKey(source, target)) ?? null;
}

function sectionKey(source: readonly number[], target: readonly number[]): string {
	return `${source.join(",")}|${target.join(",")}`;
}

/** A unit as Claude sees it for pairing: kind, word count, and its first words and last words. */
export function pairingUnit(block: Block): PairingUnit {
	const text = projectMarkdown(block.body).text;
	const words = wordsOf(text);
	const clip = (from: number, to: number): string => text.slice(words[from]?.start ?? 0, words[to - 1]?.end ?? 0).replace(/\s+/g, " ").trim();
	const tail = Math.min(EXCERPT_TAIL, words.length - EXCERPT_HEAD);
	const excerpt = tail <= 0 ? text.replace(/\s+/g, " ").trim() : `${clip(0, EXCERPT_HEAD)} … ${clip(words.length - tail, words.length)}`;
	return { kind: block.kind as PairingUnit["kind"], words: words.length, excerpt };
}

/** Text-region units other than headings and footnotes, with matcher features; sections follow headings. */
function matchable(note: NoteStructure): { block: Block; item: MatchItem }[] {
	const units = new Set(textUnits(note));
	let section = -1;
	const result: { block: Block; item: MatchItem }[] = [];
	for (const block of note.blocks) {
		if (!units.has(block)) continue;
		if (block.kind === "heading") section++;
		else if (block.kind !== "footnote") result.push({ block, item: matchItem(block, projectMarkdown(block.body).text, section) });
	}
	return result;
}

/** An `align` marker on its own line after the block (and its own-line id, existing or inserted in the same write); several keys name a merged unit. */
function markerAfter(text: string, starts: readonly number[], block: Block, keys: readonly UnitKey[], ownLineIdPending: boolean): Insert {
	const last = Math.max(block.lines.end - 1, block.idLine ?? -1);
	const [key] = keys as [UnitKey];
	const marker = serializeMenardLine({ kind: "marker", key, ...(keys.length > 1 ? { group: keys } : {}), task: "align" });
	return lineInsertAfter(text, starts, last, marker, ownLineIdPending);
}

function firstWords(block: Block): string {
	const text = projectMarkdown(block.body).text;
	const words = wordsOf(text);
	const cut = words[PREVIEW_WORDS - 1]?.end;
	return cut === undefined || cut >= text.trimEnd().length ? text.trim() : `${text.slice(0, cut).trim()}…`;
}
