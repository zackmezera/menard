/**
 * Translate or align every note in a folder: one preflight, one progress
 * notice, then Translate note or Align with existing translation for each
 * source note in name order, and a summary per note. Each note's job
 * resumes from its own markers, so running the batch again resumes it.
 * Owner: jobs module. DESIGN.md §7.7.
 */
import { TFile } from "obsidian";
import type { TFolder } from "obsidian";
import { FM } from "../constants";
import { isMenardError } from "../errors";
import { parseOptions } from "../settings";
import { parseNote, textUnits } from "../text/blocks";
import { locateMenardLines } from "../text/edits";
import type { Block, PairLanguages } from "../types";
import { translationPath } from "../vault/properties";
import { runAlign } from "./align";
import type { JobDeps } from "./controller";
import { uiOf } from "./modals";
import type { JobUi } from "./modals";
import { messageFor } from "./progress";
import type { ProgressSink } from "./progress";
import { sameLanguage } from "./language";
import { keyedUnits, linkedNote, parseTarget, pendingMarkers, requireClaude, runTranslate, sameLanguageMessage } from "./translate";

/** What the batch does with one note. */
export type BatchAction = "translate" | "resume" | "align" | "done";

export interface BatchItem {
	file: TFile;
	action: BatchAction;
	/** The translation note Align pairs it with, or that Translate resumes. */
	target: TFile | null;
	/** Rough number of Claude calls: the paragraphs to process. */
	calls: number;
}

export interface BatchPreflight {
	folderName: string;
	languages: PairLanguages;
	items: readonly BatchItem[];
	model: string;
}

const SENTENCE_KINDS: ReadonlySet<Block["kind"]> = new Set<Block["kind"]>(["paragraph", "quote", "callout"]);
export const BATCH_TITLE = "Translate or align folder";

/**
 * The source notes directly in `folder`, in name order, with what the batch
 * would do to each. Translation notes, notes without text, and a note that
 * is another note's same-named translation (`X (EN).md` beside `X.md`) are
 * left out.
 */
export async function planBatch(deps: JobDeps, folder: TFolder, target: string): Promise<BatchItem[]> {
	const { vault } = deps.ctx.app;
	const options = parseOptions(deps.ctx.settings());
	const notes = folder.children
		.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	const partners = new Set(notes.map((note) => translationPath(note.path, target)));
	const items: BatchItem[] = [];
	for (const file of notes) {
		if (partners.has(file.path) || deps.pairs.resolve(file)?.side === "target" || linkedNote(deps, file, FM.source) !== null) continue;
		const units = textUnits(parseNote(await vault.read(file), options)).filter((block) => block.kind !== "heading");
		if (units.length === 0) continue;
		const linked = deps.pairs.resolve(file)?.pair.target ?? null;
		if (linked === null) {
			const partner = vault.getFileByPath(translationPath(file.path, target));
			const calls = partner === null ? units.length : units.filter((block) => SENTENCE_KINDS.has(block.kind)).length;
			items.push({ file, action: partner === null ? "translate" : "align", target: partner, calls });
			continue;
		}
		items.push({ file, target: linked, ...linkedWork(await vault.read(file), await vault.read(linked), options, units) });
	}
	return items;
}

/**
 * A linked pair: resume a pending translation; align when markers wait, a
 * paired paragraph has no map, or nothing was ever aligned; else done.
 */
function linkedWork(sourceText: string, targetText: string, options: ReturnType<typeof parseOptions>, units: readonly Block[]): { action: BatchAction; calls: number } {
	const translate = pendingMarkers(targetText, "translate").length;
	if (translate > 0) return { action: "resume", calls: translate };
	const lines = locateMenardLines(targetText);
	if (lines.length === 0) return { action: "align", calls: units.filter((block) => SENTENCE_KINDS.has(block.kind)).length };
	const lined = new Set(lines.flatMap((line) => line.keys));
	const sourceKeys = new Set(keyedUnits(parseNote(sourceText, options)).map((unit) => unit.key));
	const unmapped = keyedUnits(parseTarget(targetText, options)).filter(
		({ key, block }) => SENTENCE_KINDS.has(block.kind) && sourceKeys.has(key) && !lined.has(key),
	).length;
	const calls = pendingMarkers(targetText, "align").length + unmapped;
	return calls > 0 ? { action: "align", calls } : { action: "done", calls: 0 };
}

export async function runBatch(deps: JobDeps, folder: TFolder, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	if (!(await requireClaude(deps, ui))) return;
	const proposed = { source: settings.defaultSourceLanguage, target: settings.defaultTargetLanguage };
	let items = await planBatch(deps, folder, proposed.target);
	if (!items.some((item) => item.action !== "done")) {
		ui.notice(items.length === 0 ? "This folder has no notes to translate or align." : "Every note in this folder is already translated or aligned.");
		return;
	}
	const languages = await ui.confirmBatch({ folderName: folder.name || "/", languages: proposed, items, model: settings.model });
	if (languages === null) return;
	if (sameLanguage(languages.source, languages.target)) {
		ui.explain(BATCH_TITLE, sameLanguageMessage(languages.source));
		return;
	}
	if (languages.target !== proposed.target) items = await planBatch(deps, folder, languages.target);

	const progress = ui.progress(`Folder ${folder.name || "/"}`, () => controller.abort());
	const work = items.filter((item) => item.action !== "done");
	const tally = { done: 0, failed: 0, total: work.reduce((sum, item) => sum + item.calls, 0) };
	const lines: string[] = [];
	for (const item of items) {
		const name = item.file.basename;
		if (item.action === "done") {
			lines.push(`${name}: already done.`);
			continue;
		}
		if (controller.signal.aborted) {
			lines.push(`${name}: not started.`);
			continue;
		}
		const said: string[] = [];
		const noteDeps: JobDeps = { ...deps, ui: noteUi(ui, languages, progress, tally, said) };
		try {
			if (item.action === "align" && item.target !== null) {
				await addMissingLanguages(deps, item.target, languages);
				await runAlign(noteDeps, item.file, item.target, controller);
			} else {
				await runTranslate(noteDeps, item.file, controller);
			}
		} catch (error) {
			if (!isMenardError(error)) console.error("Menard: unexpected error in a folder batch.", error);
			said.push(messageFor(error));
		}
		lines.push(`${name}: ${said.join(" ") || "nothing to do."}`);
	}
	const stopped = controller.signal.aborted ? "Stopped. Run the command again to resume. " : "";
	progress.finish(`${stopped}${work.length} ${work.length === 1 ? "note" : "notes"} processed in ${folder.name || "/"}. See the summary.`);
	ui.explain(BATCH_TITLE, lines.join("\n"));
}

/** Sets the batch languages on a translation note about to be aligned, where it has none. */
async function addMissingLanguages(deps: JobDeps, target: TFile, languages: PairLanguages): Promise<void> {
	const frontmatter = deps.ctx.app.metadataCache.getFileCache(target)?.frontmatter ?? {};
	const missing: Record<string, string> = {};
	if (frontmatter[FM.sourceLanguage] === undefined) missing[FM.sourceLanguage] = languages.source;
	if (frontmatter[FM.targetLanguage] === undefined) missing[FM.targetLanguage] = languages.target;
	if (Object.keys(missing).length > 0) await deps.writer.setFrontmatter(target, missing);
}

/**
 * The UI one note's job sees inside the batch: its questions are answered
 * by the batch preflight, its progress feeds the batch's one notice, and
 * what it says is collected for the summary.
 */
function noteUi(ui: JobUi, languages: PairLanguages, batch: ProgressSink, tally: { done: number; failed: number; total: number }, said: string[]): JobUi {
	return {
		confirmTranslate: (info) => Promise.resolve(info.resume ? info.languages : languages),
		confirmAlign: () => Promise.resolve(true),
		confirmSplit: () => Promise.resolve(null),
		confirmBatch: () => Promise.resolve(null),
		confirmReplaceEdited: () => Promise.resolve(false),
		pickNote: () => Promise.resolve(null),
		showReport: () => undefined,
		explain: (_title, message) => void said.push(message),
		notice: (message) => void said.push(message),
		progress: () => {
			const base = { done: tally.done, failed: tally.failed };
			return {
				update: (done, failed, running) => {
					tally.done = base.done + done;
					tally.failed = base.failed + failed;
					batch.update(tally.done, tally.failed, running, Math.max(tally.total, tally.done + tally.failed));
				},
				finish: (summary) => void said.push(summary),
				close: () => undefined,
			};
		},
	};
}
