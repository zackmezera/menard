/**
 * Entry point for every job; one job at a time per vault.
 * Owner: jobs module. DESIGN.md §7.
 */
import type { TFile, TFolder } from "obsidian";
import { MenardError, isMenardError } from "../errors";
import { pingPrompt } from "../llm/prompts";
import { parseOptions } from "../settings";
import { parseNote } from "../text/blocks";
import type { BackupStore, DetectResult, JobsApi, MenardContext, NoteWriter, PairIndex, PairLink, TranslationBackend, UnitKey } from "../types";
import { runAlign } from "./align";
import { runBatch } from "./batch";
import { runCheck } from "./check";
import { uiOf } from "./modals";
import type { JobUi } from "./modals";
import type { ProgressSink } from "./progress";
import { messageFor } from "./progress";
import { runRealign, runRetranslate } from "./retranslate";
import { runSplit } from "./split";
import { detectClaude, runTranslate } from "./translate";

/** Everything a job needs, injected so tests can pass fakes. */
export interface JobDeps {
	ctx: MenardContext;
	pairs: PairIndex;
	writer: NoteWriter;
	backups: BackupStore;
	backend: TranslationBackend;
	/** Modals, notices and progress; defaults to Obsidian's. */
	ui?: JobUi;
	/** Status-bar item that mirrors job progress. */
	statusBar?: HTMLElement | null;
	/** Finds the `claude` executable; defaults to the path setting plus the usual install locations. */
	detect?: () => Promise<DetectResult>;
	/** Opens the facing view of a pair, offered when a job finishes. */
	openFacing?: (file: TFile) => Promise<void>;
}

/** Starts `work` as the running job, if no other job runs. */
export type StartJob = (work: (controller: AbortController) => Promise<void>) => Promise<void>;

export class JobController implements JobsApi {
	private running: AbortController | null = null;
	private disposed = false;
	/** Progress shown by the running job, closed on dispose. */
	private readonly open = new Set<ProgressSink>();

	constructor(private readonly injected: JobDeps) {}

	/** The injected dependencies, with a UI that goes quiet once the controller is disposed. */
	private get deps(): JobDeps {
		return { ...this.injected, ui: this.silencedOnDispose(uiOf(this.injected)) };
	}

	canTranslate(file: TFile): boolean {
		return this.running === null && file.extension === "md" && this.injected.pairs.resolve(file)?.side !== "target";
	}

	translate(file: TFile): Promise<void> {
		return this.start((controller) => runTranslate(this.deps, file, controller));
	}

	canAlign(file: TFile): boolean {
		return this.canTranslate(file);
	}

	align(file: TFile): Promise<void> {
		return this.start((controller) => runAlign(this.deps, file, null, controller));
	}

	canSplit(file: TFile, text: string): boolean {
		if (this.running !== null || file.extension !== "md") return false;
		const settings = this.injected.ctx.settings();
		const wanted = settings.translationHeading.trim().toLowerCase();
		if (wanted === "") return false;
		return parseNote(text, parseOptions(settings)).blocks.some((block) => block.kind === "heading" && block.body.trim().toLowerCase() === wanted);
	}

	split(file: TFile): Promise<void> {
		return this.start((controller) => runSplit(this.deps, file, controller));
	}

	/** True when no job runs; the batch itself reports a folder with nothing to do. */
	canBatch(folder: TFolder | null): boolean {
		return this.running === null && folder !== null;
	}

	batch(folder: TFolder): Promise<void> {
		return this.start((controller) => runBatch(this.deps, folder, controller));
	}

	retranslate(pair: PairLink, key: UnitKey): Promise<void> {
		return this.start((controller) => runRetranslate(this.deps, pair, key, controller));
	}

	realign(pair: PairLink, key: UnitKey): Promise<void> {
		return this.start((controller) => runRealign(this.deps, pair, key, controller));
	}

	checkPair(file: TFile): Promise<void> {
		return runCheck(this.deps, file, (work) => this.start(work));
	}

	/** Detects the CLI and sends a one-line request; reports the path, model and latency. */
	async checkClaude(): Promise<void> {
		const ui = uiOf(this.deps);
		const settings = this.deps.ctx.settings();
		try {
			const found = await detectClaude(this.deps);
			if (found.path === null) {
				ui.notice(`${messageFor(new MenardError("cli-not-found", ""))} Looked in: ${found.tried.join(", ")}.`);
				return;
			}
			const result = await this.deps.backend.run({
				...pingPrompt(),
				model: settings.model,
				timeoutMs: settings.timeoutSeconds * 1000,
				signal: new AbortController().signal,
			});
			const seconds = (result.durationMs / 1000).toFixed(1);
			ui.notice(`Claude Code works: ${found.path}, model ${settings.model}, answered in ${seconds} s.`);
		} catch (error) {
			ui.notice(messageFor(error));
		}
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	/** Cancels the running job; false if none. */
	cancel(): boolean {
		if (this.running === null) return false;
		this.running.abort();
		return true;
	}

	/**
	 * For plugin unload: cancels the running job and closes its progress. The
	 * job winds down after the plugin is gone, so nothing it reports is shown,
	 * since a summary would offer commands and buttons that no longer exist.
	 */
	dispose(): void {
		this.disposed = true;
		this.cancel();
		for (const sink of this.open) sink.close();
		this.open.clear();
	}

	/** `ui` with every notice, modal and progress update dropped once the controller is disposed. */
	private silencedOnDispose(ui: JobUi): JobUi {
		const live = (): boolean => !this.disposed;
		return {
			confirmTranslate: (info) => (live() ? ui.confirmTranslate(info) : Promise.resolve(null)),
			confirmAlign: (summary) => (live() ? ui.confirmAlign(summary) : Promise.resolve(false)),
			confirmSplit: (info) => (live() ? ui.confirmSplit(info) : Promise.resolve(null)),
			confirmBatch: (info) => (live() ? ui.confirmBatch(info) : Promise.resolve(null)),
			confirmReplaceEdited: (preview) => (live() ? ui.confirmReplaceEdited(preview) : Promise.resolve(false)),
			pickNote: (exclude) => (live() ? ui.pickNote(exclude) : Promise.resolve(null)),
			showReport: (report, actions) => {
				if (live()) ui.showReport(report, actions);
			},
			explain: (title, message) => {
				if (live()) ui.explain(title, message);
			},
			notice: (message) => {
				if (live()) ui.notice(message);
			},
			progress: (title, onCancel) => {
				const sink = ui.progress(title, onCancel);
				this.open.add(sink);
				return {
					update: (done, failed, running, total) => {
						if (live()) sink.update(done, failed, running, total);
					},
					finish: (summary, action) => {
						this.open.delete(sink);
						if (live()) sink.finish(summary, action);
					},
					close: () => {
						this.open.delete(sink);
						sink.close();
					},
				};
			},
		};
	}

	/** Runs one job at a time; errors become notices, unexpected ones are also logged. */
	private async start(work: (controller: AbortController) => Promise<void>): Promise<void> {
		const ui = uiOf(this.deps);
		if (this.running !== null) {
			ui.notice("Another Menard job is running. Cancel it or wait for it to finish.");
			return;
		}
		const controller = new AbortController();
		this.running = controller;
		try {
			await work(controller);
		} catch (error) {
			if (!isMenardError(error)) console.error("Menard: unexpected error in a job.", error);
			ui.notice(messageFor(error));
		} finally {
			this.running = null;
		}
	}
}
