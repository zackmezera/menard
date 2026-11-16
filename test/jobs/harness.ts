/**
 * An in-memory vault for end-to-end job tests, wired to the real SafeWriter,
 * VaultBackupStore and PairStore; a scripted TranslationBackend; and a UI
 * that records what jobs show and answers their questions.
 *
 * Unlike test/vault/fake-app.ts, frontmatter lives in the note text: the
 * metadata cache parses it on every call and processFrontMatter rewrites
 * it, as Obsidian does, so jobs see their own frontmatter writes as edits.
 */
import { Component, TFile } from "obsidian";
import type { App } from "obsidian";
import { MenardError } from "../../src/errors";
import type { JobDeps } from "../../src/jobs/controller";
import type { BatchPreflight } from "../../src/jobs/batch";
import type { AlignSummary, JobUi, PreflightInfo, ReportActions, SplitPreflight } from "../../src/jobs/modals";
import type { NoticeAction, ProgressSink } from "../../src/jobs/progress";
import type { PairReport } from "../../src/jobs/check";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { BackendRequest, BackendResult, MenardSettings, PairLanguages, TranslationBackend } from "../../src/types";
import { VaultBackupStore } from "../../src/vault/backup";
import { PairStore } from "../../src/vault/pairs";
import { SafeWriter } from "../../src/vault/writer";

const makeFile = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Frontmatter = Record<string, unknown>;

/** Frontmatter as `key: value` entries; nested lines (lists) stay attached to their key, unparsed. */
function splitFrontmatter(text: string): { entries: { key: string; lines: string[] }[]; body: string } | null {
	if (!text.startsWith("---\n")) return null;
	let close = text.indexOf("\n---\n", 3);
	// A closing fence that ends the note without a line ending.
	if (close === -1 && text.endsWith("\n---")) close = text.length - 4;
	if (close === -1) return null;
	const entries: { key: string; lines: string[] }[] = [];
	for (const line of text.slice(4, close).split("\n")) {
		const key = /^([^\s:][^:]*):/.exec(line)?.[1];
		if (key !== undefined) entries.push({ key, lines: [line] });
		else entries[entries.length - 1]?.lines.push(line);
	}
	return { entries, body: text.slice(close + 5) };
}

function parseValue(lines: readonly string[]): unknown {
	const raw = (lines[0] ?? "").slice((lines[0] ?? "").indexOf(":") + 1).trim();
	if (lines.length > 1 && raw === "") return lines.slice(1).map((line) => line.replace(/^\s*-\s*/, ""));
	// YAML reads an unquoted [[Note]] as a list holding a list.
	const unquotedLink = /^\[\[([^[\]]+)\]\]$/.exec(raw)?.[1];
	if (unquotedLink !== undefined) return [[unquotedLink]];
	return raw.startsWith('"') ? (JSON.parse(raw) as unknown) : raw;
}

function serializeValue(value: unknown): string {
	return typeof value === "string" && /^[\w .,/()@-]+$/.test(value) ? value : JSON.stringify(value);
}

export class MemoryVault {
	readonly configDir = ".obsidian-test";
	readonly notes = new Map<string, { file: TFile; text: string }>();
	readonly adapterFiles = new Map<string, string>();
	readonly trashed: string[] = [];
	readonly adapter = {
		exists: async (path: string): Promise<boolean> => this.adapterFiles.has(path) || this.folders.has(path),
		mkdir: async (path: string): Promise<void> => {
			this.folders.add(path);
		},
		write: async (path: string, data: string): Promise<void> => {
			this.adapterFiles.set(path, data);
		},
		list: async (folder: string): Promise<{ files: string[]; folders: string[] }> => ({
			files: [...this.adapterFiles.keys()].filter((path) => path.startsWith(`${folder}/`)),
			folders: [],
		}),
		remove: async (path: string): Promise<void> => {
			this.adapterFiles.delete(path);
		},
	};
	private readonly folders = new Set<string>();

	add(path: string, text: string): TFile {
		const file = makeFile(path);
		this.notes.set(path, { file, text });
		return file;
	}

	text(file: TFile | string): string {
		const note = this.notes.get(typeof file === "string" ? file : file.path);
		if (note === undefined) throw new Error(`No note at ${typeof file === "string" ? file : file.path}`);
		return note.text;
	}

	/** Changes a note as the user would. */
	edit(file: TFile, text: string): void {
		this.entry(file).text = text;
	}

	async read(file: TFile): Promise<string> {
		await tick();
		return this.entry(file).text;
	}

	cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		await tick();
		const note = this.entry(file);
		note.text = fn(note.text);
		return note.text;
	}

	async create(path: string, text: string): Promise<TFile> {
		await tick();
		if (this.notes.has(path)) throw new Error("File already exists.");
		return this.add(path, text);
	}

	getFileByPath(path: string): TFile | null {
		return this.notes.get(path)?.file ?? null;
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.getFileByPath(path);
	}

	getMarkdownFiles(): TFile[] {
		return [...this.notes.values()].map((note) => note.file);
	}

	trash(file: TFile): void {
		this.trashed.push(file.path);
		this.notes.delete(file.path);
	}

	private entry(file: TFile): { file: TFile; text: string } {
		const note = this.notes.get(file.path);
		if (note === undefined) throw new Error(`No note at ${file.path}`);
		return note;
	}
}

function createApp(vault: MemoryVault): App {
	const metadataCache = {
		getFileCache: (file: TFile): { frontmatter?: Frontmatter } | null => {
			if (vault.getFileByPath(file.path) === null) return null;
			const split = splitFrontmatter(vault.text(file));
			return split === null ? {} : { frontmatter: Object.fromEntries(split.entries.map((e) => [e.key, parseValue(e.lines)])) };
		},
		getFirstLinkpathDest: (linkpath: string): TFile | null => {
			const files = vault.getMarkdownFiles();
			return files.find((f) => f.path === linkpath || f.path === `${linkpath}.md`) ?? files.find((f) => f.basename === linkpath) ?? null;
		},
		fileToLinktext: (file: TFile): string => file.basename,
		on: () => ({}),
	};
	const fileManager = {
		processFrontMatter: async (file: TFile, fn: (frontmatter: Frontmatter) => void): Promise<void> => {
			await tick();
			const text = vault.text(file);
			const split = splitFrontmatter(text) ?? { entries: [], body: text };
			const before = Object.fromEntries(split.entries.map((e) => [e.key, parseValue(e.lines)]));
			const after = { ...before };
			fn(after);
			const lines = split.entries.flatMap((e) => (JSON.stringify(after[e.key]) === JSON.stringify(before[e.key]) ? e.lines : [`${e.key}: ${serializeValue(after[e.key])}`]));
			for (const [key, value] of Object.entries(after)) if (!(key in before)) lines.push(`${key}: ${serializeValue(value)}`);
			vault.edit(file, `---\n${lines.join("\n")}\n---\n${split.body}`);
		},
		trashFile: async (file: TFile): Promise<void> => {
			await tick();
			vault.trash(file);
		},
	};
	return { vault, metadataCache, fileManager } as unknown as App;
}

/** Records what a job shows; answers its questions from `answers`. */
export class RecordingUi implements JobUi {
	readonly notices: string[] = [];
	readonly explained: { title: string; message: string }[] = [];
	readonly summaries: { text: string; action?: NoticeAction }[] = [];
	readonly progressUpdates: number[][] = [];
	readonly preflights: PreflightInfo[] = [];
	readonly splitPreflights: SplitPreflight[] = [];
	readonly batchPreflights: BatchPreflight[] = [];
	readonly alignSummaries: AlignSummary[] = [];
	readonly replacePreviews: string[] = [];
	readonly reports: { report: PairReport; actions: ReportActions }[] = [];
	answers = {
		translate: true,
		align: true,
		split: true,
		replaceEdited: true,
		languages: null as PairLanguages | null,
		splitLanguages: null as PairLanguages | null,
		batch: true,
		batchLanguages: null as PairLanguages | null,
	};
	picked: TFile | null = null;
	/** Progress notices closed without a summary. */
	closedProgress = 0;
	/** Called after each progress update, e.g. to cancel mid-job. */
	onProgress: ((done: number) => void) | null = null;

	async confirmTranslate(info: PreflightInfo): Promise<PairLanguages | null> {
		this.preflights.push(info);
		return this.answers.translate ? (this.answers.languages ?? info.languages) : null;
	}

	async confirmAlign(summary: AlignSummary): Promise<boolean> {
		this.alignSummaries.push(summary);
		return this.answers.align;
	}

	async confirmSplit(info: SplitPreflight): Promise<PairLanguages | null> {
		this.splitPreflights.push(info);
		return this.answers.split ? (this.answers.splitLanguages ?? info.languages) : null;
	}

	async confirmBatch(info: BatchPreflight): Promise<PairLanguages | null> {
		this.batchPreflights.push(info);
		return this.answers.batch ? (this.answers.batchLanguages ?? info.languages) : null;
	}

	async confirmReplaceEdited(preview: string): Promise<boolean> {
		this.replacePreviews.push(preview);
		return this.answers.replaceEdited;
	}

	async pickNote(): Promise<TFile | null> {
		return this.picked;
	}

	showReport(report: PairReport, actions: ReportActions): void {
		this.reports.push({ report, actions });
	}

	explain(title: string, message: string): void {
		this.explained.push({ title, message });
	}

	notice(message: string): void {
		this.notices.push(message);
	}

	progress(): ProgressSink {
		return {
			update: (done, failed, running, total) => {
				this.progressUpdates.push([done, failed, running, total]);
				this.onProgress?.(done);
			},
			finish: (text, action) => {
				this.summaries.push(action === undefined ? { text } : { text, action });
			},
			close: () => {
				this.closedProgress++;
			},
		};
	}
}

export type Handler = (request: BackendRequest, call: number) => unknown;

/** A backend that answers from a handler; it honours the abort signal like the CLI does. */
export class ScriptedBackend implements TranslationBackend {
	readonly name = "scripted";
	readonly requests: BackendRequest[] = [];

	constructor(public handler: Handler = fakeClaude) {}

	async run(request: BackendRequest): Promise<BackendResult> {
		this.requests.push(request);
		if (request.signal.aborted) throw new MenardError("cancelled", "Cancelled.");
		const output = await this.handler(request, this.requests.length);
		await tick();
		if (request.signal.aborted) throw new MenardError("cancelled", "Cancelled.");
		return { output, durationMs: 1200 };
	}
}

/** The call kind, from the request's JSON schema. */
export function callKind(request: BackendRequest): "translate" | "align" | "pairing" | "plain" | "outline" | "ping" {
	const properties = (request.schema as { properties: Record<string, unknown> }).properties;
	if ("headings" in properties) return "outline";
	if ("ok" in properties) return "ping";
	if ("markdown" in properties) return "plain";
	const group = (properties.groups as { items: { properties: Record<string, unknown> } }).items.properties;
	if (!("tgt" in group)) return "translate";
	return "loose" in group ? "align" : "pairing";
}

/** The JSON payload of a request, without retry feedback. */
export function payloadOf<T>(request: BackendRequest): T {
	return JSON.parse(request.prompt.split("\n\nYour previous answer was rejected")[0] ?? "{}") as T;
}

/** A deterministic stand-in for Claude: "translates" by tagging text, aligns one to one when it can. */
export function fakeClaude(request: BackendRequest): unknown {
	switch (callKind(request)) {
		case "translate": {
			const payload = payloadOf<{ sentences: { n: number; text: string }[]; calloutTitle?: string }>(request);
			return {
				groups: payload.sentences.map((sentence) => ({ src: [sentence.n], markdown: `EN ${sentence.text.trim()}` })),
				...(payload.calloutTitle === undefined ? {} : { calloutTitle: `EN ${payload.calloutTitle}` }),
			};
		}
		case "plain":
			return { markdown: payloadOf<{ markdown: string }>(request).markdown.replace(/edición/g, "edition") };
		case "outline":
			return { headings: payloadOf<{ headings: string[] }>(request).headings.map((heading) => `EN ${heading}`) };
		case "align": {
			const { source, target } = payloadOf<{ source: unknown[]; target: unknown[] }>(request);
			const numbers = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
			if (source.length === target.length) return { groups: numbers(source.length).map((n) => ({ src: [n], tgt: [n], loose: false })) };
			return { groups: [{ src: numbers(source.length), tgt: numbers(target.length), loose: true }] };
		}
		case "pairing": {
			// Pairs down the diagonal; the longer side's extra units stay unpaired.
			const { source, target } = payloadOf<{ source: unknown[]; target: unknown[] }>(request);
			const groups = Array.from({ length: Math.max(source.length, target.length) }, (_, i) => ({
				src: i < source.length ? [i + 1] : [],
				tgt: i < target.length ? [i + 1] : [],
			}));
			return { groups };
		}
		case "ping":
			return { ok: true };
	}
}

export interface Harness {
	vault: MemoryVault;
	ui: RecordingUi;
	backend: ScriptedBackend;
	settings: MenardSettings;
	deps: JobDeps;
	opened: string[];
}

export function createHarness(settings: Partial<MenardSettings> = {}): Harness {
	const vault = new MemoryVault();
	const app = createApp(vault);
	const merged: MenardSettings = { ...DEFAULT_SETTINGS, concurrency: 1, ...settings };
	const ctx = { app, settings: () => merged, owner: new Component() };
	const ui = new RecordingUi();
	const backend = new ScriptedBackend();
	const opened: string[] = [];
	const deps: JobDeps = {
		ctx,
		pairs: new PairStore(ctx),
		writer: new SafeWriter(app),
		backups: new VaultBackupStore(app, () => merged.backupCount, `${vault.configDir}/plugins/menard`),
		backend,
		ui,
		detect: async () => ({ path: "/Users/test/.local/bin/claude", via: "candidate", tried: ["/Users/test/.local/bin/claude"] }),
		openFacing: async (file) => {
			opened.push(file.path);
		},
	};
	return { vault, ui, backend, settings: merged, deps, opened };
}
