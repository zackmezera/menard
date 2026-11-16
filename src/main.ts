/**
 * Plugin entry point: wires the modules together and registers commands.
 * Owner: integration. No logic beyond wiring lives here (DESIGN.md §3).
 */
import { MarkdownView, Notice, Plugin, TFolder } from "obsidian";
import type { TFile } from "obsidian";
import type { Extension } from "@codemirror/state";
import { openProblemReport } from "./diagnose/modal";
import { CLS } from "./constants";
import { MenardError } from "./errors";
import { JobController } from "./jobs/controller";
import { ClaudeCliBackend } from "./llm/claude-cli";
import { detectClaude } from "./llm/detect";
import { POSITIONS_KEY, ReadingPositions } from "./reader/positions";
import { SessionManager } from "./reader/sessions";
import { OffscreenGloss } from "./render/gloss";
import { livePreviewExtension } from "./render/live-preview";
import { createPostProcessor } from "./render/postprocessor";
import { registerImportCommands } from "./import/commands";
import { DEFAULT_SETTINGS } from "./settings";
import { MenardSettingTab } from "./settings-tab";
import { SENTENCE_UNIT_KINDS } from "./types";
import type { DetectResult, JobsApi, MenardContext, MenardSettings, PairLink, PairUnit, ReaderApi, UnitKey } from "./types";
import { VaultBackupStore } from "./vault/backup";
import { PairStore } from "./vault/pairs";
import { SafeWriter } from "./vault/writer";

/** A unit addressed by a command: from the editor cursor line, else the reading cursor. */
interface CommandUnit {
	pair: PairLink;
	key: UnitKey;
}

/** Block ids that can follow `#^` in a link; footnote and heading keys cannot. */
const LINKABLE_KEY_RE = /^[A-Za-z0-9-]+$/;

export default class MenardPlugin extends Plugin {
	override settings: MenardSettings = { ...DEFAULT_SETTINGS };
	/** Swapped in place on settings changes, then `workspace.updateOptions()` (DESIGN.md §9.6). */
	private readonly editorExtensions: Extension[] = [];
	private ctx: MenardContext | null = null;
	private pairs!: PairStore;
	private jobs!: JobsApi;
	private reader!: ReaderApi;
	/** The pending or successful detection for the current `claudePath`. */
	private located: { setting: string; result: Promise<DetectResult> } | null = null;
	/** The last reading-cursor stop per source note, stored in plugin data beside the settings. */
	private readonly positions = new ReadingPositions(() => void this.saveData(this.persisted()));

	override async onload(): Promise<void> {
		await this.loadSettings();
		const ctx: MenardContext = { app: this.app, settings: () => this.settings, owner: this };
		this.ctx = ctx;

		this.pairs = new PairStore(ctx);
		this.pairs.start();
		const backend = new ClaudeCliBackend(
			() => this.claudeExecutable(),
			() => {
				this.located = null;
			},
		);
		this.register(() => backend.killAll());

		const sessions = new SessionManager(ctx, this.pairs, new OffscreenGloss(this.app), this.positions);
		this.register(() => this.positions.flush());
		this.reader = sessions;
		const jobs = new JobController({
			ctx,
			pairs: this.pairs,
			writer: new SafeWriter(this.app),
			backups: new VaultBackupStore(this.app, () => this.settings.backupCount, this.pluginFolder()),
			backend,
			statusBar: this.addStatusBarItem(),
			detect: () => this.locateClaude(),
			openFacing: (file) => sessions.openFacing(file),
		});
		this.jobs = jobs;
		this.register(() => jobs.dispose());
		sessions.start();

		this.registerMarkdownPostProcessor(createPostProcessor(ctx, this.pairs, sessions), 100);
		this.editorExtensions.push(livePreviewExtension(ctx, this.pairs));
		this.registerEditorExtension(this.editorExtensions);

		this.addSettingTab(new MenardSettingTab(this.app, this));
		this.registerCommands();
		registerImportCommands(this, new SafeWriter(this.app), () => this.settings, jobs);

		this.applyDim(document.body);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.applyDim(win.doc.body)));
		this.register(() => this.eachBody((body) => body.removeClass(CLS.dimInactive)));
	}

	/** The fade setting lives on each window's body; styles.css does the rest. */
	private applyDim(body: HTMLElement): void {
		body.toggleClass(CLS.dimInactive, this.settings.dimInactive);
		body.setCssProps({ "--menard-dim-opacity": String(this.settings.dimOpacity / 100) });
	}

	private eachBody(run: (body: HTMLElement) => void): void {
		run(document.body);
		this.app.workspace.iterateAllLeaves((leaf) => {
			const body = leaf.view.containerEl.ownerDocument.body;
			if (body !== document.body) run(body);
		});
	}

	async loadSettings(): Promise<void> {
		const stored: unknown = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...(isRecord(stored) ? (stored as Partial<MenardSettings>) : {}) };
		this.positions.load(isRecord(stored) ? stored[POSITIONS_KEY] : undefined);
		delete (this.settings as unknown as Record<string, unknown>)[POSITIONS_KEY];
	}

	/** Persists the settings and refreshes what reads them at registration time. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.persisted());
		if (!this.ctx) return;
		this.editorExtensions.length = 0;
		this.editorExtensions.push(livePreviewExtension(this.ctx, this.pairs));
		this.app.workspace.updateOptions();
		// Rebuilds cached pair models when the text region or languages changed; their listeners repaint (#27).
		this.pairs.settingsChanged();
		this.reader.settingsChanged();
		this.eachBody((body) => this.applyDim(body));
	}

	/** Plugin data: the settings and the reading positions. */
	private persisted(): Record<string, unknown> {
		return { ...this.settings, [POSITIONS_KEY]: this.positions.toJSON() };
	}

	/** Runs the CLI connection check (settings tab action). */
	checkClaude(): Promise<void> {
		return this.jobs.checkClaude();
	}

	/** The folder Obsidian installed the plugin in, which need not be named after its id. */
	private pluginFolder(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	/**
	 * Finds `claude` from the path setting and the usual install locations. A
	 * failed search is not cached, and the backend forgets a found path that
	 * could no longer be started.
	 */
	private locateClaude(): Promise<DetectResult> {
		const setting = this.settings.claudePath;
		if (this.located?.setting === setting) return this.located.result;
		const entry = { setting, result: detectClaude(setting, { probeShell: false }) };
		this.located = entry;
		const forget = (): void => {
			if (this.located === entry) this.located = null;
		};
		entry.result.then((found) => {
			if (found.path === null) forget();
		}, forget);
		return entry.result;
	}

	private async claudeExecutable(): Promise<string> {
		const found = await this.locateClaude();
		if (found.path === null) {
			throw new MenardError("cli-not-found", `Claude Code was not found. Looked in: ${found.tried.join(", ")}.`, found);
		}
		return found.path;
	}

	private registerCommands(): void {
		const { jobs, reader, pairs } = this;
		const onFile = (id: string, name: string, available: (file: TFile) => boolean, run: (file: TFile) => Promise<void>): void => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || !available(file)) return false;
					if (!checking) void run(file);
					return true;
				},
			});
		};
		const onUnit = (id: string, name: string, available: (unit: PairUnit) => boolean, run: (unit: CommandUnit) => Promise<void>): void => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const target = this.commandUnit();
					const unit = target ? pairs.peek(target.pair.source.path)?.unit(target.key) : undefined;
					if (!target || !unit || jobs.isRunning() || !available(unit)) return false;
					if (!checking) void run(target);
					return true;
				},
			});
		};
		const when = (id: string, name: string, available: () => boolean, run: () => unknown): void => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					if (!available()) return false;
					if (!checking) run();
					return true;
				},
			});
		};
		const inSession = (): boolean => reader.hasActiveSession();

		onFile("translate-note", "Translate note", (file) => jobs.canTranslate(file), (file) => jobs.translate(file));
		onFile("align-with-translation", "Align with existing translation", (file) => jobs.canAlign(file), (file) => jobs.align(file));
		this.addCommand({
			id: "translate-folder",
			name: "Translate or align every note in this folder",
			checkCallback: (checking) => {
				const folder = this.app.workspace.getActiveFile()?.parent ?? null;
				if (folder === null || !jobs.canBatch(folder)) return false;
				if (!checking) void jobs.batch(folder);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder) || !jobs.canBatch(file)) return;
				menu.addItem((item) => item.setTitle("Translate or align every note").setIcon("languages").onClick(() => void jobs.batch(file)));
			}),
		);
		onFile("split-combined-note", "Split into source and translation notes", (file) => this.canSplit(file), (file) => jobs.split(file));
		onUnit(
			"retranslate-paragraph",
			"Re-translate paragraph",
			(unit) => unit.source !== null && unit.kind !== "heading",
			(unit) => jobs.retranslate(unit.pair, unit.key),
		);
		onUnit(
			"realign-paragraph",
			"Re-align paragraph",
			(unit) => unit.source !== null && unit.target !== null && SENTENCE_UNIT_KINDS.includes(unit.kind),
			(unit) => jobs.realign(unit.pair, unit.key),
		);
		onFile("check-alignment", "Check alignment", (file) => pairs.mayBePair(file.path), (file) => jobs.checkPair(file));
		when("cancel-job", "Cancel translation job", () => jobs.isRunning(), () => jobs.cancel());
		this.addCommand({ id: "check-claude", name: "Check Claude connection", callback: () => void jobs.checkClaude() });
		onFile("open-facing-view", "Open facing view", (file) => pairs.resolve(file) !== null, (file) => reader.openFacing(file));
		this.addCommand({
			id: "toggle-stacked-view",
			name: "Toggle stacked view",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || view.getMode() !== "preview" || pairs.resolve(view.file)?.side !== "source") return false;
				if (!checking) reader.toggleStacked(view.leaf);
				return true;
			},
		});
		when("next-sentence", "Next sentence", inSession, () => reader.step("link", 1));
		when("previous-sentence", "Previous sentence", inSession, () => reader.step("link", -1));
		when("next-paragraph", "Next paragraph", inSession, () => reader.step("unit", 1));
		when("previous-paragraph", "Previous paragraph", inSession, () => reader.step("unit", -1));
		when("reveal-translation", "Reveal translation", () => reader.canReveal(), () => reader.reveal());
		when("toggle-reveal-mode", "Toggle hidden translation", () => reader.canToggleRevealMode(), () => reader.toggleRevealMode());
		when("clear-reading-cursor", "Clear reading cursor", () => reader.currentUnit() !== null, () => reader.clearCursor());
		this.addCommand({
			id: "report-problem",
			name: "Report a problem",
			callback: () =>
				void openProblemReport({ app: this.app, pairs, reader, settings: this.settings, pluginVersion: this.manifest.version }),
		});
		when(
			"copy-paragraph-link",
			"Copy link to current paragraph",
			() => LINKABLE_KEY_RE.test(reader.currentUnit()?.key ?? ""),
			() => void this.copyParagraphLink(),
		);
	}

	/** A cheap heading check from the metadata cache, then the jobs module's test on the open text. */
	private canSplit(file: TFile): boolean {
		const wanted = this.settings.translationHeading.trim().toLowerCase();
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		if (wanted === "" || !headings.some((entry) => entry.heading.trim().toLowerCase() === wanted)) return false;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file === file && this.jobs.canSplit(file, view.getViewData());
	}

	/** The unit at the editor cursor line in editing mode, else the unit under the reading cursor. */
	private commandUnit(): CommandUnit | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file && view.getMode() === "source") {
			const resolved = this.pairs.resolve(view.file);
			if (!resolved) return null;
			const unit = this.pairs.peek(view.file.path)?.unitAtLine(resolved.side, view.editor.getCursor().line);
			return unit ? { pair: resolved.pair, key: unit.key } : null;
		}
		return this.reader.currentUnit();
	}

	private async copyParagraphLink(): Promise<void> {
		const current = this.reader.currentUnit();
		if (!current) return;
		const active = this.app.workspace.getActiveFile();
		const file = active === current.pair.target ? current.pair.target : current.pair.source;
		const linktext = this.app.metadataCache.fileToLinktext(file, "");
		await navigator.clipboard.writeText(`[[${linktext}#^${current.key}]]`);
		new Notice("Link copied.");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
