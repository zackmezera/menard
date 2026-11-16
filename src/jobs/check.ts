/**
 * Check pair: a read-only report of the pair's alignment health, with
 * actions to refresh repaired maps or realign degraded ones.
 * Owner: jobs module. DESIGN.md §7.6.
 */
import type { TFile } from "obsidian";
import { linksFromRanges, parseMenardLine, serializeMenardLine, sideOf } from "../align/map";
import { fitUnitSide, sideProjection } from "../align/merge";
import { buildPairModel } from "../align/model";
import { reconcileSide } from "../align/reconcile";
import { wordsOf } from "../align/words";
import { FM } from "../constants";
import { parseOptions } from "../settings";
import { parseNote, textUnits } from "../text/blocks";
import { locateMenardLines } from "../text/edits";
import { projectMarkdown } from "../text/inline";
import type { Block, MapLink, NoteStructure, PairLink, PairModel, ReconciledSide, UnitKey } from "../types";
import { requestRealign, runAlignMarkers } from "./align";
import type { JobDeps, StartJob } from "./controller";
import { uiOf } from "./modals";
import { keyedUnits, linkPair, linkedNote, needsId, pairLanguages, parseTarget, runTranslate } from "./translate";

export interface PairReport {
	unpairedSource: UnitKey[];
	/** Source text units with no id yet, so never translated: their first lines (0-based). */
	untranslated: number[];
	unpairedTarget: UnitKey[];
	pending: UnitKey[];
	/** Maps whose text changed but positions are certain; refreshable without Claude. */
	repaired: UnitKey[];
	/** Maps that need realigning, and sentence units with no map at all. */
	degraded: UnitKey[];
	/** Malformed or orphaned Menard lines, by line number in the translation note. */
	problems: number[];
}

/**
 * Computes the report by reconciling every map against the current
 * projections of both units, as the model holds them. Pure.
 */
export function reportPair(model: PairModel, source?: NoteStructure): PairReport {
	const report: PairReport = { unpairedSource: [], untranslated: [], unpairedTarget: [], pending: [], repaired: [], degraded: [], problems: [] };
	if (source !== undefined) report.untranslated = textUnits(source).filter(needsId).map((block) => block.lines.start);
	for (const unit of model.units) {
		if (unit.kind === "heading") continue;
		if (unit.pending !== null) report.pending.push(unit.key);
		else if (unit.target === null) report.unpairedSource.push(unit.key);
		else if (unit.source === null) report.unpairedTarget.push(unit.key);
		else if (unit.kind === "paragraph" || unit.kind === "quote" || unit.kind === "callout") {
			if (unit.map === null) {
				report.degraded.push(unit.key);
				continue;
			}
			const statuses = [fitUnitSide(unit, "source")?.status, fitUnitSide(unit, "target")?.status];
			if (statuses.includes("degraded")) report.degraded.push(unit.key);
			else if (statuses.includes("repaired")) report.repaired.push(unit.key);
		}
	}
	report.problems = model.problems.map((problem) => problem.line);
	return report;
}

/**
 * Recomputes counts and hashes of a repaired map from the current inline
 * Markdown of both units (a body, or the blocks of a merged side in order),
 * keeping its link structure. Pure. Throws when a side no longer
 * reconciles with certain positions.
 */
export function refreshLinks(links: readonly MapLink[], sourceText: string | readonly Block[], targetText: string | readonly Block[]): MapLink[] {
	const side = (key: "src" | "tgt", body: string | readonly Block[]): { words: ReturnType<typeof wordsOf>; ranges: ReconciledSide["ranges"] } => {
		const text = typeof body === "string" ? projectMarkdown(body).text : sideProjection(body);
		const words = wordsOf(text);
		const reconciled = reconcileSide(sideOf(links, key), words, text);
		if (reconciled.status === "degraded") throw new Error("The map no longer fits the text and needs realigning.");
		return { words, ranges: reconciled.ranges };
	};
	return linksFromRanges(
		side("src", sourceText),
		side("tgt", targetText),
		links.map((link) => link.loose),
	);
}

export async function runCheck(deps: JobDeps, file: TFile, start: StartJob): Promise<void> {
	const ui = uiOf(deps);
	const resolved = deps.pairs.resolve(file);
	if (resolved === null) {
		const pair = oneSidedPair(deps, file);
		if (pair === null) {
			ui.notice("This note is not part of a pair.");
			return;
		}
		const empty: PairReport = { unpairedSource: [], untranslated: [], unpairedTarget: [], pending: [], repaired: [], degraded: [], problems: [] };
		ui.showReport(empty, {
			repairLink: () =>
				void start(async () => {
					await linkPair(deps, pair.source, pair.target);
					ui.notice("The pair link was repaired.");
				}),
		});
		return;
	}
	const { pair } = resolved;
	const { model, source } = await freshModel(deps, pair);
	const report = reportPair(model, source);
	const waiting = (task: "translate" | "align"): boolean => model.units.some((unit) => unit.pending === task);
	ui.showReport(report, {
		refresh: () => void start(() => refreshMaps(deps, pair, report.repaired)),
		realign: () =>
			void start(async (controller) => {
				await requestRealign(deps, pair, report.degraded);
				await runAlignMarkers(deps, pair, report.degraded, controller);
			}),
		resume: () =>
			void start(async (controller) => {
				if (waiting("translate") || report.untranslated.length > 0) await runTranslate(deps, pair.source, controller);
				if (waiting("align") && !controller.signal.aborted) await runAlignMarkers(deps, pair, null, controller);
			}),
	});
}

/** The pair's model built from both notes' current text, not the reader's cache. */
async function freshModel(deps: JobDeps, pair: PairLink): Promise<{ model: PairModel; source: NoteStructure }> {
	const settings = deps.ctx.settings();
	const options = parseOptions(settings);
	const { vault } = deps.ctx.app;
	const [sourceText, targetText] = await Promise.all([vault.read(pair.source), vault.read(pair.target)]);
	const source = parseNote(sourceText, options);
	const model = buildPairModel({
		sourcePath: pair.source.path,
		targetPath: pair.target.path,
		languages: pairLanguages(deps, pair.target, settings),
		version: 0,
		source,
		target: parseTarget(targetText, options),
	});
	return { model, source };
}

/** Rewrites the maps of `keys` from current text, in one Menard-owned write. */
async function refreshMaps(deps: JobDeps, pair: PairLink, keys: readonly UnitKey[]): Promise<void> {
	const ui = uiOf(deps);
	const options = parseOptions(deps.ctx.settings());
	const sources = new Map(keyedUnits(parseNote(await deps.ctx.app.vault.read(pair.source), options)).map((u) => [u.key, u.block]));
	const wanted = new Set(keys);
	let refreshed = 0;
	const outcome = await deps.writer.rewriteOwned(pair.target, (text) => {
		refreshed = 0;
		const targets = new Map(keyedUnits(parseTarget(text, options)).map((u) => [u.key, u.block]));
		const replacements = locateMenardLines(text).flatMap((line) => {
			const parsed = parseMenardLine(line.raw);
			const source = line.keys.flatMap((key) => sources.get(key) ?? []);
			const target = line.keys.flatMap((key) => targets.get(key) ?? []);
			if ("error" in parsed || parsed.kind !== "map" || !wanted.has(parsed.key) || source.length === 0 || target.length === 0) return [];
			try {
				const links = refreshLinks(parsed.links, source, target);
				refreshed++;
				return [{ from: line.from, to: line.to, expect: line.raw, text: serializeMenardLine({ ...parsed, links }) }];
			} catch {
				return [];
			}
		});
		return replacements.length === 0 ? "noop" : replacements;
	});
	if (!outcome.ok) throw outcome.error;
	ui.notice(`Refreshed ${refreshed} sentence ${refreshed === 1 ? "map" : "maps"}.`);
}

/** Source and translation when exactly one of them links to the other. */
function oneSidedPair(deps: JobDeps, file: TFile): PairLink | null {
	const translation = linkedNote(deps, file, FM.translation);
	if (translation !== null) return { source: file, target: translation };
	const source = linkedNote(deps, file, FM.source);
	return source === null ? null : { source, target: file };
}
