/**
 * Translate note: ids on the source, outline call, skeleton, then one task
 * per pending marker; resumable from the markers. Also the helpers every
 * job shares: CLI detection, validated model calls, marker replacement and
 * the queued run with its summary. Owner: jobs module. DESIGN.md §7.1.
 */
import type { TFile } from "obsidian";
import { parseMenardLine, serializeMenardLine } from "../align/map";
import { footnoteKey } from "../align/model";
import { FM } from "../constants";
import { MenardError, isMenardError } from "../errors";
import type { MenardErrorCode } from "../errors";
import { detectClaude as detectExecutable } from "../llm/detect";
import { outlinePrompt, plainPrompt, translatePrompt } from "../llm/prompts";
import { protect } from "../llm/protect";
import { validateOutline, validatePlain, validateTranslate } from "../llm/validate";
import { parseOptions } from "../settings";
import { abbreviationsFor } from "../text/abbreviations";
import { parseNote, textUnits } from "../text/blocks";
import { applyInserts, lineEnd, lineStarts, locateMenardLines } from "../text/edits";
import { allocateIds, idInserts } from "../text/ids";
import { projectMarkdown } from "../text/inline";
import type {
	BackendResult,
	Block,
	DetectResult,
	Insert,
	MenardSettings,
	NoteStructure,
	PairLanguages,
	ParseOptions,
	PromptParts,
	SegmentRules,
	TranslateUnitInput,
	UnitKey,
	Validation,
} from "../types";
import { linkpathOf } from "../vault/pairs";
import { parseNewNoteProperties, translationPath, wikilinkValue } from "../vault/properties";
import { assemblePlainUnit, assembleSentenceUnit, prepareSentenceUnit, rulesFor } from "./assemble";
import type { JobDeps } from "./controller";
import { declaredLanguage, guessLanguage, languageName, proposeLanguages, sameLanguage } from "./language";
import { uiOf } from "./modals";
import type { JobUi } from "./modals";
import { messageFor } from "./progress";
import type { NoticeAction, ProgressSink } from "./progress";
import { JobQueue } from "./queue";
import type { JobReport, Task } from "./queue";
import { buildSkeleton, newNoteFrontmatter } from "./skeleton";

/** Backend failures that are retried once before the unit fails. */
const TRANSIENT_CODES: ReadonlySet<MenardErrorCode> = new Set<MenardErrorCode>(["cli-timeout", "cli-crash", "cli-bad-envelope", "cli-model-error"]);
/** Each side of the previous unit given to the model as context. */
const CONTEXT_CHARS = 1500;
/** Rough seconds per unit, for the preflight estimate. */
const SECONDS_PER_UNIT = 20;
const KEY_RE = /^(?:[A-Za-z0-9-]+|fn:[A-Za-z0-9_-]+)$/;
/** Characters of the first text unit shown in the preflight. */
const PREVIEW_CHARS = 80;

/** A text-region unit with the key that pairs it. */
export interface KeyedBlock {
	key: UnitKey;
	block: Block;
}

export async function runTranslate(deps: JobDeps, source: TFile, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	const options = parseOptions(settings);
	const { vault } = deps.ctx.app;
	if (!(await requireClaude(deps, ui))) return;

	const structure = parseNote(await vault.read(source), options);
	const units = textUnits(structure).filter((block) => block.kind !== "heading");
	if (units.length === 0) {
		ui.notice("This note has no text to translate.");
		return;
	}
	const shared = sharedKeys(structure);
	if (shared.length > 0) ui.notice(sharedKeysMessage(shared));
	const resolved = deps.pairs.resolve(source);
	if (resolved?.side === "target") {
		ui.notice("This is a translation note. Run Translate note on its source.");
		return;
	}
	let target = resolved?.pair.target ?? null;
	if (target === null) {
		const refusal = unlinkedRefusal(deps, source, settings.defaultTargetLanguage);
		if (refusal !== null) {
			ui.explain("Translate note", refusal);
			return;
		}
	}

	const languages = target === null ? proposedLanguages(deps, source, settings) : pairLanguages(deps, target, settings);
	const guessedSource = target === null ? guessUnitsLanguage(units) : undefined;
	const todo = missingUnits(structure, target === null ? null : parseTarget(await vault.read(target), options));
	if (todo === 0) {
		ui.notice("This note is fully translated.");
		return;
	}
	const confirmed = await ui.confirmTranslate({
		sourceName: source.basename,
		languages,
		model: settings.model,
		units: todo,
		idsToAdd: units.filter(needsId).length,
		skippedSections: structure.blocks.filter((b) => b.kind === "heading" && b.region === "skipped").map((b) => b.body),
		...firstUnitPreview(units),
		...(guessedSource !== undefined ? { guessedSource } : {}),
		estimatedMinutes: (todo * SECONDS_PER_UNIT) / 60 / Math.max(1, settings.concurrency),
		resume: target !== null,
	});
	if (confirmed === null) return;
	if (sameLanguage(confirmed.source, confirmed.target)) {
		ui.explain("Translate note", sameLanguageMessage(confirmed.source));
		return;
	}
	if (target === null && confirmed.target !== languages.target) {
		const refusal = unlinkedRefusal(deps, source, confirmed.target);
		if (refusal !== null) {
			ui.explain("Translate note", refusal);
			return;
		}
	}

	await addSourceIds(deps, source, target, options);
	if (target === null) target = await createTranslationNote(deps, source, confirmed, controller.signal);
	else {
		const unqueued = await insertMissingMarkers(deps, source, target, options);
		if (unqueued > 0) ui.notice(unqueuedMessage(unqueued));
	}

	const job: TranslateJob = { source, target, languages: confirmed, options };
	const markers = pendingMarkers(await vault.read(target), "translate");
	const tasks = markers.map((key): Task => ({ key, run: (signal) => translateMarker(deps, job, key, signal) }));
	const run = await runQueued(deps, ui, `Translating ${source.basename}`, tasks, controller);
	run.progress.finish(summarize(run.report, tasks.length, TRANSLATE_WORDS), facingAction(deps, run.report, source));
}

const TRANSLATE_WORDS = { done: "Translated", gerund: "Translation", command: "Translate note" };

// ─── The translate job ─────────────────────────────────────────────────────

interface TranslateJob {
	source: TFile;
	target: TFile;
	languages: PairLanguages;
	options: ParseOptions;
}

/** Translates the unit of one marker from the current source text and replaces the marker. */
async function translateMarker(deps: JobDeps, job: TranslateJob, key: UnitKey, signal: AbortSignal): Promise<void> {
	const { vault } = deps.ctx.app;
	const units = keyedUnits(parseNote(await vault.read(job.source), job.options));
	const index = units.findIndex((unit) => unit.key === key);
	const unit = units[index];
	if (unit === undefined) throw new Error(`The source unit ${key} is no longer there.`);
	const previous = units.slice(0, index).reverse().find((u) => u.block.kind !== "footnote");
	const context = previous === undefined ? undefined : await contextFor(deps, job, previous);
	const replacement = await translateUnitText(deps, { ...job, documentTitle: job.source.basename, context }, unit, signal);
	await replaceMarker(deps, job.target, key, "translate", replacement);
}

export interface UnitTranslation {
	languages: PairLanguages;
	documentTitle: string;
	context: TranslateUnitInput["context"];
}

/**
 * Translates one unit: the block (with its id) followed, for a sentence
 * unit, by a blank line and its sentence map. Throws output-invalid when the
 * model's answers fail validation `maxRetries + 1` times.
 */
export async function translateUnitText(deps: JobDeps, input: UnitTranslation, unit: KeyedBlock, signal: AbortSignal): Promise<string> {
	const settings = deps.ctx.settings();
	const { block, key } = unit;
	if (block.kind !== "paragraph" && block.kind !== "quote" && block.kind !== "callout") return translatePlain(deps, input, unit, signal);

	const rules = rulesFor(block, segmentBase(settings, input.languages.source));
	const prepared = prepareSentenceUnit(block, rules);
	if (prepared.sentences.length === 0) return assemblePlainUnit(key, block, block.raw, [], "\n");
	const request: TranslateUnitInput = {
		key,
		kind: block.kind,
		languages: input.languages,
		documentTitle: input.documentTitle,
		sentences: prepared.protectedSentences,
		extraInstructions: settings.extraInstructions,
		...(block.calloutTitle !== undefined && block.calloutTitle !== "" ? { calloutTitle: block.calloutTitle } : {}),
		...(input.context !== undefined ? { context: input.context } : {}),
	};
	const output = await callValidated(
		deps,
		(retryErrors) => translatePrompt({ ...request, ...(retryErrors ? { retryErrors } : {}) }),
		(raw) => validateTranslate(request, prepared.tokens, raw),
		signal,
	);
	const assembled = assembleSentenceUnit({ key, block, sentences: prepared.sentences, tokens: prepared.tokens }, output, "\n");
	return `${assembled.block}\n\n${serializeMenardLine(assembled.map)}`;
}

async function translatePlain(deps: JobDeps, input: UnitTranslation, unit: KeyedBlock, signal: AbortSignal): Promise<string> {
	const settings = deps.ctx.settings();
	const { block, key } = unit;
	const kind = block.kind as "list" | "table" | "footnote";
	const prot = protect(block.body, { lineBreaks: "keep" });
	const request = {
		key,
		kind,
		languages: input.languages,
		documentTitle: input.documentTitle,
		markdown: prot.text,
		extraInstructions: settings.extraInstructions,
	};
	const output = await callValidated(
		deps,
		(retryErrors) => plainPrompt({ ...request, ...(retryErrors ? { retryErrors } : {}) }),
		(raw) => validatePlain(request, prot.tokens, raw),
		signal,
	);
	return assemblePlainUnit(key, block, output.markdown, prot.tokens, "\n");
}

async function contextFor(deps: JobDeps, job: TranslateJob, previous: KeyedBlock): Promise<TranslateUnitInput["context"]> {
	const translated = keyedUnits(parseTarget(await deps.ctx.app.vault.read(job.target), job.options)).find((u) => u.key === previous.key);
	return unitContext(previous.block, translated?.block);
}

/** The previous unit's projections, given to the model as context, each cut to its last 1,500 characters. */
export function unitContext(source: Block, translation: Block | undefined): NonNullable<TranslateUnitInput["context"]> {
	const clip = (body: string): string => projectMarkdown(body).text.slice(-CONTEXT_CHARS).trim();
	return translation === undefined ? { source: clip(source.body) } : { source: clip(source.body), target: clip(translation.body) };
}

/** The first words of the first text unit, as the reader sees them, for the preflight. */
export function firstUnitPreview(units: readonly Block[]): { firstUnit?: string } {
	const first = units.find((block) => block.kind !== "footnote") ?? units[0];
	if (first === undefined) return {};
	const text = projectMarkdown(first.body).text.replace(/\s+/g, " ").trim();
	if (text === "") return {};
	return { firstUnit: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text };
}

// ─── Setting up the pair ───────────────────────────────────────────────────

export function needsId(block: Block): boolean {
	return block.kind !== "heading" && block.kind !== "footnote" && block.id === null;
}

/**
 * One insert-only write giving every text-region unit of the source an id.
 * New ids avoid every id and key the translation note still holds, so a new
 * paragraph never takes the key of a deleted one whose translation remains.
 */
async function addSourceIds(deps: JobDeps, source: TFile, target: TFile | null, options: ParseOptions): Promise<void> {
	const reserved = target === null ? undefined : keysIn(await deps.ctx.app.vault.read(target), options);
	const outcome = await deps.writer.insert(source, (text) => {
		const structure = parseNote(text, options);
		const missing = textUnits(structure).filter(needsId);
		if (missing.length === 0) return "noop";
		const ids = allocateIds(structure, missing.length, reserved);
		return idInserts(text, structure, missing.map((block, i) => ({ block, id: ids[i] as string })));
	});
	if (!outcome.ok) throw outcome.error;
}

/** Every block id and Menard line key in a translation note. */
function keysIn(text: string, options: ParseOptions): Set<string> {
	return new Set([...parseTarget(text, options).usedIds, ...locateMenardLines(text).flatMap((line) => line.keys)]);
}

/** Keys that two or more text-region units share; keyedUnits leaves those units out. */
export function sharedKeys(structure: NoteStructure): UnitKey[] {
	const counts = new Map<UnitKey, number>();
	for (const block of textUnits(structure)) {
		const key = unitKey(block);
		if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].flatMap(([key, count]) => (count > 1 ? [key] : []));
}

function sharedKeysMessage(keys: readonly UnitKey[]): string {
	const names = keys.map((key) => (key.startsWith("fn:") ? `[^${key.slice(3)}]` : `^${key}`)).join(", ");
	return `Some paragraphs or footnotes were skipped because they share a key with another: ${names}. Give each its own id or label, then run Translate note again.`;
}

function unqueuedMessage(count: number): string {
	const what = count === 1 ? "1 footnote was" : `${count} footnotes were`;
	return `${what} not queued because the translation note ends inside an unclosed code or math block. Close it, then run Translate note again.`;
}

/** Why Translate note must not create a translation note here, or null. */
function unlinkedRefusal(deps: JobDeps, source: TFile, targetLanguage: string): string | null {
	if (linkedNote(deps, source, FM.translation) !== null) return messageFor(new MenardError("pair-not-reciprocal", ""));
	const path = translationPath(source.path, targetLanguage);
	if (deps.ctx.app.vault.getFileByPath(path) !== null) {
		return `“${path}” already exists but is not linked to this note. Run Align with existing translation to pair them.`;
	}
	return null;
}

/**
 * The languages proposed for a new pair: the source note's declared
 * language (originalLanguage, language or lang; a name such as "spanish" or
 * a code) when it has one, else the defaults (#25).
 */
export function proposedLanguages(deps: JobDeps, source: TFile, settings: MenardSettings): PairLanguages {
	const frontmatter = deps.ctx.app.metadataCache.getFileCache(source)?.frontmatter;
	return proposeLanguages(declaredLanguage(frontmatter), { source: settings.defaultSourceLanguage, target: settings.defaultTargetLanguage });
}

/** A stopword guess at the language of the units' visible text, or undefined. */
export function guessUnitsLanguage(units: readonly Block[]): string | undefined {
	const text = units
		.filter((block) => block.kind !== "heading" && block.kind !== "footnote")
		.map((block) => projectMarkdown(block.body).text)
		.join("\n");
	return guessLanguage(text) ?? undefined;
}

export function sameLanguageMessage(language: string): string {
	return `The source and target languages are both ${languageName(language)}, so there is nothing to translate. Choose a different target language.`;
}

/** The pair's languages from the translation note's frontmatter, falling back to the defaults. */
export function pairLanguages(deps: JobDeps, target: TFile, settings: MenardSettings): PairLanguages {
	const frontmatter = deps.ctx.app.metadataCache.getFileCache(target)?.frontmatter;
	const read = (key: string, fallback: string): string => {
		const value: unknown = frontmatter?.[key];
		return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
	};
	return { source: read(FM.sourceLanguage, settings.defaultSourceLanguage), target: read(FM.targetLanguage, settings.defaultTargetLanguage) };
}

/** Outline call, skeleton, create, and both frontmatter links. */
async function createTranslationNote(deps: JobDeps, source: TFile, languages: PairLanguages, signal: AbortSignal): Promise<TFile> {
	const { app } = deps.ctx;
	const settings = deps.ctx.settings();
	const structure = parseNote(await app.vault.read(source), parseOptions(settings));
	const path = translationPath(source.path, languages.target);

	const headingIndices = structure.blocks.flatMap((block, index) => (block.kind === "heading" && block.region === "text" ? [index] : []));
	const translated = await translateHeadings(deps, languages, source.basename, headingIndices.map((index) => structure.blocks[index]?.body ?? ""), signal);
	const headings = new Map(headingIndices.map((index, i) => [index, translated[i] ?? ""]));
	const keys = new Map(keyedUnits(structure).map(({ key, block }) => [structure.blocks.indexOf(block), key]));
	const frontmatter = newNoteFrontmatter(
		wikilinkValue(app.metadataCache.fileToLinktext(source, path)),
		languages,
		parseNewNoteProperties(settings.newNoteProperties),
	);
	const target = await deps.writer.create(path, buildSkeleton({ source: structure, keys, headings, frontmatter }));
	try {
		await linkPair(deps, source, target);
	} catch (error) {
		// An unlinked note at the translation path would block both Translate and Align.
		await deps.writer.trashCreated(target);
		throw error;
	}
	return target;
}

/**
 * Sets `translation:` on the source and `source:` on the translation, each
 * only when it does not already link there, so a linked pair's frontmatter
 * is never rewritten.
 */
export async function linkPair(deps: JobDeps, source: TFile, target: TFile): Promise<void> {
	const { metadataCache } = deps.ctx.app;
	if (linkedNote(deps, source, FM.translation) !== target) {
		await deps.writer.setFrontmatter(source, { [FM.translation]: wikilinkValue(metadataCache.fileToLinktext(target, source.path)) });
	}
	if (linkedNote(deps, target, FM.source) !== source) {
		await deps.writer.setFrontmatter(target, { [FM.source]: wikilinkValue(metadataCache.fileToLinktext(source, target.path)) });
	}
}

/** Logged once per session: the heading translation fell back to the source headings. */
let warnedHeadings = false;

/** Translated heading texts; on invalid answers the source headings stay, so the job can go on. */
async function translateHeadings(deps: JobDeps, languages: PairLanguages, documentTitle: string, headings: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
	if (headings.length === 0) return [];
	const input = { languages, documentTitle, headings, extraInstructions: deps.ctx.settings().extraInstructions };
	try {
		return (await callValidated(deps, () => outlinePrompt(input), (raw) => validateOutline(input, raw), signal)).headings;
	} catch (error) {
		if (isMenardError(error, "output-invalid")) {
			// Not fatal, but not silent (#35): Report a problem lists headings that read the same in both notes.
			if (!warnedHeadings) console.warn("Menard: Claude's heading translation stayed invalid; the source headings were kept.", error.message);
			warnedHeadings = true;
			return headings;
		}
		throw error;
	}
}

/**
 * Inserts a `translate` marker for every source unit that has neither a
 * translation nor a marker: after the nearest preceding unit or heading
 * present in the translation note (headings pair by order), at the top of
 * the body when there is none, and footnote markers at the end. Insert-only.
 * Returns how many footnote markers could not be placed because the note
 * ends inside an unclosed code or math block.
 */
async function insertMissingMarkers(deps: JobDeps, source: TFile, target: TFile, options: ParseOptions): Promise<number> {
	const sourceNote = parseNote(await deps.ctx.app.vault.read(source), options);
	const keys = new Map(keyedUnits(sourceNote).map(({ key, block }) => [block, key]));
	let unqueued = 0;
	const outcome = await deps.writer.insert(target, (text) => {
		const structure = parseTarget(text, options);
		const lastLines = presentUnits(structure);
		const headings = structure.blocks.filter((block) => block.kind === "heading" && block.region === "text");
		const starts = lineStarts(text);
		const inserts: Insert[] = [];
		let anchor: number | null = null;
		let heading = -1;
		unqueued = 0;
		for (const block of textUnits(sourceNote)) {
			if (block.kind === "heading") {
				const translated = headings[++heading];
				if (translated !== undefined) anchor = translated.lines.end - 1;
				continue;
			}
			const key = keys.get(block);
			if (key === undefined) continue;
			const line = lastLines.get(key);
			if (line !== undefined) {
				if (block.kind !== "footnote") anchor = line;
				continue;
			}
			const marker = serializeMenardLine({ kind: "marker", key, task: "translate" });
			if (block.kind === "footnote") {
				const insert = appendAtEnd(text, marker, options);
				if (insert === null) unqueued++;
				else inserts.push(insert);
			} else if (anchor === null) inserts.push(bodyStartInsert(text, starts, structure, marker));
			else inserts.push(lineInsertAfter(text, starts, anchor, marker, false));
		}
		return inserts.length === 0 ? "noop" : inserts;
	});
	if (!outcome.ok) throw outcome.error;
	return unqueued;
}

/** `line` and a blank line at the start of the body; after a frontmatter fence that ends the text without a line ending, on a line of its own. */
function bodyStartInsert(text: string, starts: readonly number[], structure: NoteStructure, line: string): Insert {
	const at = starts[structure.frontmatter?.end ?? 0] ?? 0;
	return at === text.length && at > 0 && !text.endsWith("\n") ? { at, text: `\n${line}\n` } : { at, text: `${line}\n\n` };
}

/**
 * How many source units the job would translate: units still without an id,
 * and keyed units with no translation or a pending marker in the
 * translation note (all of them when there is none yet). Units that cannot
 * carry a key are not counted, because no job can translate them.
 */
function missingUnits(source: NoteStructure, target: NoteStructure | null): number {
	const keyed = keyedUnits(source);
	const present = target === null ? new Map<UnitKey, number>() : presentUnits(target);
	const unkeyed = textUnits(source).filter(needsId).length;
	return unkeyed + keyed.filter(({ key }) => !present.has(key) || (target !== null && pendingIn(target, key))).length;
}

function pendingIn(target: NoteStructure, key: UnitKey): boolean {
	return target.blocks.some((block) => {
		if (block.kind !== "menard") return false;
		const parsed = parseMenardLine(block.raw);
		return !("error" in parsed) && parsed.kind === "marker" && parsed.task === "translate" && parsed.key === key;
	});
}

/** For each key with a unit or a Menard line in the translation note, the last line it occupies. */
function presentUnits(target: NoteStructure): Map<UnitKey, number> {
	const lastLines = new Map<UnitKey, number>();
	const note = (key: UnitKey, line: number): void => {
		lastLines.set(key, Math.max(line, lastLines.get(key) ?? -1));
	};
	for (const block of target.blocks) {
		if (block.kind === "menard") {
			const parsed = parseMenardLine(block.raw);
			// Every key of a merged unit is present: its paragraphs are translated together (ADR 0010).
			if (!("error" in parsed)) for (const key of parsed.group ?? [parsed.key]) note(key, block.lines.start);
			continue;
		}
		const key = block.region === "text" ? unitKey(block) : null;
		if (key !== null) note(key, Math.max(block.lines.end - 1, block.idLine ?? -1));
	}
	return lastLines;
}

/** `line` on its own at the end of the note, or null when an unclosed code or math block would swallow it. */
function appendAtEnd(text: string, line: string, options: ParseOptions): Insert | null {
	const insert = { at: text.length, text: text === "" ? `${line}\n` : text.endsWith("\n") ? `\n${line}\n` : `\n\n${line}\n` };
	const last = parseTarget(applyInserts(text, [insert]), options).blocks.at(-1);
	return last?.kind === "menard" && last.raw === line ? insert : null;
}

// ─── Shared by the jobs ────────────────────────────────────────────────────

/** The Markdown note that `file`'s frontmatter `key` links to, whether or not it links back. */
export function linkedNote(deps: JobDeps, file: TFile, key: string): TFile | null {
	const { metadataCache } = deps.ctx.app;
	const linkpath = linkpathOf(metadataCache.getFileCache(file)?.frontmatter?.[key]);
	if (linkpath === null) return null;
	const dest = metadataCache.getFirstLinkpathDest(linkpath, file.path);
	return dest !== null && dest !== file && dest.extension === "md" ? dest : null;
}

/** The key a unit block pairs by: its block id, `fn:<n>` for a footnote, null for anything else. */
export function unitKey(block: Block): UnitKey | null {
	if (block.kind === "footnote") {
		const key = footnoteKey(block.footnoteLabel ?? "");
		return KEY_RE.test(key) ? key : null;
	}
	if (block.kind === "heading" || block.kind === "verbatim" || block.kind === "menard") return null;
	return block.id;
}

/**
 * The text-region units that have a key, in document order. A key that two
 * units share (a repeated block id, or footnote labels such as `3` and
 * `en-3` that pair alike) is ambiguous, and neither unit is returned, so no
 * job can write one unit's text in the other's place.
 */
export function keyedUnits(structure: NoteStructure): KeyedBlock[] {
	const shared = new Set(sharedKeys(structure));
	return textUnits(structure).flatMap((block) => {
		const key = unitKey(block);
		return key === null || shared.has(key) ? [] : [{ key, block }];
	});
}

/**
 * An insert that puts `line` on its own after line `last`: a blank line
 * before it and, when text follows directly, a blank line after it, so the
 * Menard line never joins the next block. When `idPending` is true, an
 * own-line id inserted at the same offset already supplies the line break
 * that text/ids.ts adds before following text.
 */
export function lineInsertAfter(text: string, starts: readonly number[], last: number, line: string, idPending: boolean): Insert {
	const next = last + 1;
	const followed = next < starts.length - 1 && text.slice(starts[next], lineEnd(text, starts, next)).trim() !== "";
	return { at: lineEnd(text, starts, last), text: `${idPending && followed ? "\n" : "\n\n"}${line}${followed ? "\n" : ""}` };
}

/** Parses a translation note: everything after the frontmatter is its text. */
export function parseTarget(text: string, options: ParseOptions): NoteStructure {
	return parseNote(text, { textStartHeading: "", skipHeadings: options.skipHeadings });
}

/** Keys of the pending markers of one task, in document order. */
export function pendingMarkers(text: string, task: "translate" | "align"): UnitKey[] {
	return locateMenardLines(text).flatMap((line) => {
		const parsed = parseMenardLine(line.raw);
		return !("error" in parsed) && parsed.kind === "marker" && parsed.task === task ? [parsed.key] : [];
	});
}

/** Segmentation rules for a language, without the line-break rule. */
export function segmentBase(settings: MenardSettings, lang: string): Omit<SegmentRules, "lineBreaks"> {
	return { lang, abbreviations: abbreviationsFor(lang, settings.extraAbbreviations), splitDialogue: settings.splitDialogue };
}

/** The `claude` executable, from the injected detector or the path setting and the usual locations. */
export function detectClaude(deps: JobDeps): Promise<DetectResult> {
	return deps.detect?.() ?? detectExecutable(deps.ctx.settings().claudePath, { probeShell: false });
}

/** False, after telling the user, when the CLI cannot be found. */
export async function requireClaude(deps: JobDeps, ui: JobUi): Promise<boolean> {
	if ((await detectClaude(deps)).path !== null) return true;
	ui.notice(messageFor(new MenardError("cli-not-found", "")));
	return false;
}

/**
 * One model call with validation. Transient backend failures are retried
 * once; invalid answers are retried up to `maxRetries` times with the
 * validation errors fed back. Throws output-invalid after that.
 */
export async function callValidated<T>(
	deps: JobDeps,
	build: (retryErrors: readonly string[] | undefined) => PromptParts,
	validate: (output: unknown) => Validation<T>,
	signal: AbortSignal,
): Promise<T> {
	const maxRetries = deps.ctx.settings().maxRetries;
	let retryErrors: readonly string[] | undefined;
	for (let attempt = 0; ; attempt++) {
		const result = await runBackend(deps, build(retryErrors), signal);
		const validation = validate(result.output);
		if (validation.ok) return validation.value;
		if (attempt >= maxRetries) {
			throw new MenardError("output-invalid", `Claude's answer was rejected: ${validation.errors.join("; ")}.`, validation.errors);
		}
		retryErrors = validation.errors;
	}
}

async function runBackend(deps: JobDeps, parts: PromptParts, signal: AbortSignal): Promise<BackendResult> {
	const settings = deps.ctx.settings();
	const request = { ...parts, model: settings.model, timeoutMs: settings.timeoutSeconds * 1000, signal };
	try {
		return await deps.backend.run(request);
	} catch (error) {
		if (!isMenardError(error) || !TRANSIENT_CODES.has(error.code) || signal.aborted) throw error;
		return deps.backend.run(request);
	}
}

/**
 * Replaces the pending marker of `key` (the first key of a merged unit's
 * marker) with `replacement` (a Menard-owned rewrite), retrying once on a
 * write conflict. The marker is found afresh in the current text, so
 * results may land in any order.
 */
export async function replaceMarker(deps: JobDeps, target: TFile, key: UnitKey, task: "translate" | "align", replacement: string): Promise<void> {
	const isMarker = (raw: string): boolean => {
		const parsed = parseMenardLine(raw);
		return !("error" in parsed) && parsed.kind === "marker" && parsed.key === key && parsed.task === task;
	};
	const write = (): ReturnType<typeof deps.writer.rewriteOwned> =>
		deps.writer.rewriteOwned(target, (text) => {
			const line = locateMenardLines(text).find((found) => isMarker(found.raw));
			return line === undefined ? "conflict" : [{ from: line.from, to: line.to, expect: line.raw, text: replacement }];
		});
	let outcome = await write();
	if (!outcome.ok && isMenardError(outcome.error, "write-conflict")) outcome = await write();
	if (!outcome.ok) throw outcome.error;
}

/** Runs the tasks through the queue with a progress notice whose Cancel aborts the job. */
export async function runQueued(
	deps: JobDeps,
	ui: JobUi,
	title: string,
	tasks: readonly Task[],
	controller: AbortController,
): Promise<{ report: JobReport; progress: ProgressSink }> {
	const progress = ui.progress(title, () => controller.abort());
	const report = await new JobQueue(deps.ctx.settings().concurrency).run(tasks, controller, {
		onProgress: (done, failed, running, total) => progress.update(done, failed, running, total),
	});
	return { report, progress };
}

/** The end-of-job summary, per DESIGN.md §7.1 and §11. */
export function summarize(report: JobReport, total: number, words: { done: string; gerund: string; command: string }): string {
	const written = `${report.done} of ${total} written`;
	if (report.stoppedBy === "cli-rate-limited") return `Claude usage limit reached. ${written}; run ${words.command} later to resume.`;
	if (report.stoppedBy !== undefined) return `${messageFor(new MenardError(report.stoppedBy as MenardErrorCode, ""))} ${written}.`;
	if (report.cancelled) return `${words.gerund} cancelled: ${written}. Run ${words.command} again to resume.`;
	if (report.failed.length > 0) {
		return `${words.done} ${report.done} of ${total}; ${report.failed.length} failed. Run ${words.command} again to retry.`;
	}
	return `${words.done} ${report.done} of ${total}.`;
}

/** The summary's Open facing view button, when something was written and the reader is wired. */
export function facingAction(deps: JobDeps, report: JobReport, file: TFile): NoticeAction | undefined {
	const open = deps.openFacing;
	if (open === undefined || report.done === 0) return undefined;
	return { label: "Open facing view", run: () => void open(file).catch((error: unknown) => console.error("Menard: could not open the facing view.", error)) };
}
