/**
 * Re-translate one unit and Re-align one unit. Owner: jobs module.
 * DESIGN.md §7.5.
 */
import { parseMenardLine, sideOf } from "../align/map";
import { sideProjection } from "../align/merge";
import { reconcileSide } from "../align/reconcile";
import { wordsOf } from "../align/words";
import { MenardError } from "../errors";
import { parseOptions } from "../settings";
import { parseNote } from "../text/blocks";
import { lineEnd, lineStarts, locateMenardLines } from "../text/edits";
import type { Block, MapLink, PairLink, ParseOptions, Replacement, UnitKey } from "../types";
import { requestRealign, runAlignMarkers } from "./align";
import type { JobDeps } from "./controller";
import { uiOf } from "./modals";
import { messageFor } from "./progress";
import { keyedUnits, pairLanguages, parseTarget, requireClaude, translateUnitText, unitContext } from "./translate";
import type { KeyedBlock } from "./translate";

/** Characters of the edited translation shown when asking to replace it. */
const PREVIEW_CHARS = 300;

/**
 * Replaces the unit's translation and map; asks first and backs up if the
 * translation was edited, before the model call or during it. A merged
 * unit (ADR 0010) is translated paragraph by paragraph, as Translate note
 * would have: its translation and map give way to one translated block and
 * map per source paragraph, so the merge dissolves.
 */
export async function runRetranslate(deps: JobDeps, pair: PairLink, key: UnitKey, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	const options = parseOptions(settings);
	const { vault } = deps.ctx.app;
	if (!(await requireClaude(deps, ui))) return;

	const sourceUnits = keyedUnits(parseNote(await vault.read(pair.source), options));
	const targetText = await vault.read(pair.target);
	const keys = groupOf(targetText, key);
	key = keys[0] as UnitKey;
	const units = keys.flatMap((k) => sourceUnits.find((unit) => unit.key === k) ?? []);
	const translated = keyedUnits(parseTarget(targetText, options));
	const current = blocksOf(translated, keys);
	const [first] = units;
	if (first === undefined || current.length === 0) {
		ui.notice("This paragraph has no translation yet. Run Translate note.");
		return;
	}
	if (wasEdited(current, mapOf(targetText, key)) && !(await ui.confirmReplaceEdited(previewOf(current)))) return;

	const index = sourceUnits.indexOf(first);
	const previous = sourceUnits.slice(0, index).reverse().find((u) => u.block.kind !== "footnote");
	const context = previous === undefined ? undefined : unitContext(previous.block, translated.find((u) => u.key === previous.key)?.block);

	const progress = ui.progress(`Re-translating ${key}`, () => controller.abort());
	progress.update(0, 0, 1, 1);
	try {
		const languages = pairLanguages(deps, pair.target, settings);
		const parts: string[] = [];
		for (const [i, unit] of units.entries()) {
			const before = i === 0 ? context : unitContext((units[i - 1] as KeyedBlock).block, undefined);
			parts.push(await translateUnitText(deps, { languages, documentTitle: pair.source.basename, context: before }, unit, controller.signal));
		}
		const replacement = parts.join("\n\n");
		const expected = current.map((block) => block.raw);
		const latest = blocksOf(keyedUnits(parseTarget(await vault.read(pair.target), options)), keys);
		if (latest.length === 0) throw new MenardError("write-conflict", "The translation moved while it was being re-translated.");
		if (latest.map((block) => block.raw).join("\n") !== expected.join("\n") && !(await ui.confirmReplaceEdited(previewOf(latest)))) {
			progress.finish(`Kept your edit of ${key}; the new translation was discarded.`);
			return;
		}
		const latestRaws = latest.map((block) => block.raw);
		const planned = unitReplacements(await vault.read(pair.target), keys, replacement, options, latestRaws);
		if (planned !== "conflict" && planned.every((r) => r.expect === r.text)) {
			progress.finish(`Claude returned the same translation for ${key}; nothing changed.`);
			return;
		}
		const backup = await deps.backups.save(pair.target);
		const outcome = await deps.writer.replace(pair.target, backup, (text) => unitReplacements(text, keys, replacement, options, latestRaws));
		if (!outcome.ok) throw outcome.error;
		progress.finish(`Re-translated ${key}. A backup of the previous translation was saved.`);
	} catch (error) {
		progress.finish(messageFor(error));
	}
}

/** The keys of the unit `key` belongs to: its key group when a Menard line merges it (ADR 0010), else `key` alone. */
function groupOf(text: string, key: UnitKey): readonly UnitKey[] {
	for (const line of locateMenardLines(text)) {
		const parsed = parseMenardLine(line.raw);
		if (!("error" in parsed) && parsed.group?.includes(key) === true) return parsed.group;
	}
	return [key];
}

/** The blocks of `keys` that `units` holds, in key order. */
function blocksOf(units: readonly KeyedBlock[], keys: readonly UnitKey[]): Block[] {
	return keys.flatMap((k) => units.find((unit) => unit.key === k)?.block ?? []);
}

function previewOf(blocks: readonly Block[]): string {
	return sideProjection(blocks).trim().slice(0, PREVIEW_CHARS);
}

/** Replaces the unit's map with an `align` marker, then runs the sentence pass for it. */
export async function runRealign(deps: JobDeps, pair: PairLink, key: UnitKey, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const options = parseOptions(deps.ctx.settings());
	if (!(await requireClaude(deps, ui))) return;
	const targetText = await deps.ctx.app.vault.read(pair.target);
	const keys = groupOf(targetText, key);
	key = keys[0] as UnitKey;
	const target = blocksOf(keyedUnits(parseTarget(targetText, options)), keys);
	const source = blocksOf(keyedUnits(parseNote(await deps.ctx.app.vault.read(pair.source), options)), keys);
	if (source.length === 0 || target.length === 0) {
		ui.notice("This paragraph has no translation yet. Run Translate note.");
		return;
	}
	if (![...source, ...target].every(isSentenceBlock)) {
		ui.notice("Only paragraphs, quotes and callouts have sentence maps to realign.");
		return;
	}
	await requestRealign(deps, pair, [key]);
	await runAlignMarkers(deps, pair, [key], controller);
}

function isSentenceBlock(block: Block): boolean {
	return block.kind === "paragraph" || block.kind === "quote" || block.kind === "callout";
}

/** The sentence map stored for `key` (the first key of a merged unit), if any. */
function mapOf(text: string, key: UnitKey): readonly MapLink[] | null {
	for (const line of locateMenardLines(text)) {
		const parsed = parseMenardLine(line.raw);
		if (!("error" in parsed) && parsed.kind === "map" && parsed.key === key) return parsed.links;
	}
	return null;
}

/**
 * True when the translation's words no longer match its map's target side
 * exactly. A unit without a map cannot be checked and counts as edited:
 * any sentence unit that lost its map, and every list, table and footnote.
 * The blocks of a merged unit are read in order.
 */
export function wasEdited(blocks: Block | readonly Block[], links: readonly MapLink[] | null): boolean {
	const list: readonly Block[] = Array.isArray(blocks) ? blocks : [blocks as Block];
	if (!list.every(isSentenceBlock) || links === null) return true;
	const text = sideProjection(list);
	return reconcileSide(sideOf(links, "tgt"), wordsOf(text), text).status !== "exact";
}

/**
 * The replacements that swap the unit's blocks and map for `replacement`:
 * one range, from the first block through the map, when only blank lines
 * stand between; otherwise the blocks are replaced and the stray map line
 * removed. A merged unit's blocks (`key` a key group) are replaced as one
 * range, which only they may occupy. "conflict" when a block is gone or no
 * longer reads as expected.
 */
export function unitReplacements(
	text: string,
	key: UnitKey | readonly UnitKey[],
	replacement: string,
	options: ParseOptions,
	expectedRaw?: string | readonly string[],
): Replacement[] | "conflict" {
	const keys: readonly UnitKey[] = typeof key === "string" ? [key] : key;
	const units = keyedUnits(parseTarget(text, options));
	const blocks = blocksOf(units, keys);
	const expected = expectedRaw === undefined ? undefined : typeof expectedRaw === "string" ? [expectedRaw] : expectedRaw;
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	if (first === undefined || last === undefined || (expected !== undefined && blocks.map((b) => b.raw).join("\n") !== expected.join("\n"))) return "conflict";
	const starts = lineStarts(text);
	const from = starts[first.lines.start] ?? 0;
	const to = lineEnd(text, starts, Math.max(last.lines.end - 1, last.idLine ?? -1));
	const intruder = units.some(({ key: k, block }) => !keys.includes(k) && block.lines.start > first.lines.start && block.lines.start < last.lines.end);
	if (intruder) return "conflict";
	const map = locateMenardLines(text).find((line) => line.key === keys[0] && line.from >= to);
	if (map === undefined) return [{ from, to, expect: text.slice(from, to), text: replacement }];
	if (text.slice(to, map.from).trim() === "") return [{ from, to: map.to, expect: text.slice(from, map.to), text: replacement }];
	const gap = /(?:\r?\n){1,2}$/.exec(text.slice(to, map.from))?.[0].length ?? 0;
	return [
		{ from, to, expect: text.slice(from, to), text: replacement },
		{ from: map.from - gap, to: map.to, expect: text.slice(map.from - gap, map.to), text: "" },
	];
}
