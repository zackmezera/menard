/**
 * Creates and disposes sessions from workspace events, routes sections and
 * commands to them. Owner: reader module. DESIGN.md §9.2.
 */
import { MarkdownView } from "obsidian";
import type { TFile, WorkspaceLeaf } from "obsidian";
import type { GlossSource, MenardContext, PairIndex, PairLink, ReaderApi, SectionListener, UnitKey } from "../types";
import { markdownFile, openFacingView, readingPane } from "./facing";
import { registerReadingKeys } from "./keys";
import type { KeyAction, KeyContext } from "./keys";
import type { PositionStore } from "./positions";
import { PairSession } from "./session";
import type { SessionHost } from "./session";

export class SessionManager implements ReaderApi, SectionListener {
	/** One session per pair, keyed by source path. */
	private readonly sessions = new Map<string, PairSession>();
	private readonly stacked = new WeakMap<WorkspaceLeaf, boolean>();
	/** Set by the reveal-mode toggle, for the setting value it overrode; null follows the setting. */
	private revealOverride: { mode: boolean; setting: boolean } | null = null;
	private readonly host: SessionHost = {
		leaves: (path) => this.leavesShowing(path),
		isStacked: (leaf) => this.stacked.get(leaf) === true,
		revealMode: () => this.revealMode(),
		positions: {
			get: (path) => this.positions?.get(path) ?? null,
			set: (path, stop) => this.positions?.set(path, stop),
		},
	};

	constructor(
		private readonly ctx: MenardContext,
		private readonly pairs: PairIndex,
		private readonly gloss: GlossSource,
		/** The last cursor stop per source note, restored when a pair is opened again. */
		private readonly positions?: PositionStore,
	) {}

	/** Registers layout-change, active-leaf-change, file-open and window-open handlers on ctx.owner. */
	start(): void {
		const { workspace } = this.ctx.app;
		const update = (): void => this.update();
		this.ctx.owner.registerEvent(workspace.on("layout-change", update));
		this.ctx.owner.registerEvent(workspace.on("active-leaf-change", update));
		this.ctx.owner.registerEvent(workspace.on("file-open", update));
		this.ctx.owner.register(
			this.pairs.onChange((sourcePath) => {
				this.update();
				this.sessions.get(sourcePath)?.modelChanged();
			}),
		);
		registerReadingKeys(this.ctx, {
			context: () => this.keyContext(),
			act: (action, repeat) => this.act(action, repeat),
		});
		this.update();
	}

	sectionRendered(path: string, el: HTMLElement): void {
		for (const session of this.sessions.values()) if (session.has(path)) session.sectionRendered(path, el);
	}

	async openFacing(file: TFile): Promise<void> {
		const resolved = this.pairs.resolve(file);
		if (!resolved) return;
		const active = this.ctx.app.workspace.getActiveViewOfType(MarkdownView);
		const leaf = active?.file?.path === file.path ? active.leaf : this.ctx.app.workspace.getLeaf(false);
		await openFacingView(this.ctx.app, resolved.pair, leaf);
		this.update();
	}

	toggleStacked(leaf: WorkspaceLeaf): boolean {
		const file = markdownFile(leaf);
		if (!file || !readingPane(leaf) || this.pairs.resolve(file)?.side !== "source") return false;
		if (this.stacked.get(leaf)) this.stacked.delete(leaf);
		else this.stacked.set(leaf, true);
		this.update();
		return true;
	}

	step(by: "link" | "unit", delta: 1 | -1): boolean {
		const session = this.activeSession();
		if (!session) return false;
		void session.step(by, delta);
		return true;
	}

	canReveal(): boolean {
		return this.activeSession()?.canReveal() ?? false;
	}

	reveal(): boolean {
		return this.activeSession()?.reveal() ?? false;
	}

	canToggleRevealMode(): boolean {
		return this.activeSession()?.mode() === "stacked";
	}

	toggleRevealMode(): boolean {
		if (!this.canToggleRevealMode()) return false;
		this.revealOverride = { mode: !this.revealMode(), setting: this.ctx.settings().revealMode };
		for (const each of this.sessions.values()) each.refresh();
		return true;
	}

	settingsChanged(): void {
		// Reading the mode drops a toggle made before the setting changed.
		this.revealMode();
		for (const session of this.sessions.values()) session.refresh();
	}

	clearCursor(): boolean {
		const session = this.activeSession();
		if (!session?.state().cursor) return false;
		void session.setCursor(null);
		return true;
	}

	currentUnit(): { pair: PairLink; key: UnitKey } | null {
		const session = this.activeSession();
		const cursor = session?.state().cursor;
		if (!session || !cursor) return null;
		const source = this.ctx.app.vault.getFileByPath(session.sourcePath);
		const target = this.ctx.app.vault.getFileByPath(session.targetPath);
		return source && target ? { pair: { source, target }, key: cursor.unit } : null;
	}

	hasActiveSession(): boolean {
		return this.activeSession() !== null;
	}

	/** Creates sessions for pairs shown in reading view, disposes those no longer shown, refreshes the rest. */
	private update(): void {
		const wanted = new Map<string, PairLink>();
		this.ctx.app.workspace.iterateAllLeaves((leaf) => {
			const file = markdownFile(leaf);
			const resolved = file && this.pairs.mayBePair(file.path) ? this.pairs.resolve(file) : null;
			if (!resolved) {
				this.stacked.delete(leaf);
				return;
			}
			if (resolved.side !== "source") this.stacked.delete(leaf);
			const key = resolved.pair.source.path;
			if (this.sessions.has(key) || readingPane(leaf)) wanted.set(key, resolved.pair);
		});

		for (const [key, session] of this.sessions) {
			if (wanted.get(key)?.target.path === session.targetPath) continue;
			this.ctx.owner.removeChild(session);
			this.sessions.delete(key);
		}
		for (const [key, pair] of wanted) {
			if (this.sessions.has(key)) continue;
			const session = new PairSession(pair.source.path, pair.target.path, this.ctx, this.pairs, this.gloss, this.host);
			this.sessions.set(key, this.ctx.owner.addChild(session));
			void this.pairs.load(pair.source).then(() => {
				if (this.sessions.get(key) === session) void session.restore();
			});
		}
		for (const session of this.sessions.values()) session.refresh();
	}

	private activeSession(): PairSession | null {
		const path = this.ctx.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
		if (!path) return null;
		for (const session of this.sessions.values()) if (session.has(path)) return session;
		return null;
	}

	private keyContext(): KeyContext | null {
		const view = this.ctx.app.workspace.getActiveViewOfType(MarkdownView);
		const session = this.activeSession();
		if (!session || !view || !readingPane(view.leaf)) return null;
		return { revealable: session.canReveal(), hasCursor: session.state().cursor !== null };
	}

	private act(action: KeyAction, repeat: boolean): boolean {
		const session = this.activeSession();
		if (!session) return false;
		switch (action) {
			case "next":
				void session.step("link", 1, { repeat });
				return true;
			case "previous":
				void session.step("link", -1, { repeat });
				return true;
			case "next-unit":
				void session.step("unit", 1, { repeat });
				return true;
			case "previous-unit":
				void session.step("unit", -1, { repeat });
				return true;
			case "reveal":
				return session.reveal();
			case "clear":
				return this.clearCursor();
		}
	}

	/** The toggled mode until the reveal-mode setting itself changes, then the setting. */
	private revealMode(): boolean {
		const setting = this.ctx.settings().revealMode;
		if (this.revealOverride?.setting === setting) return this.revealOverride.mode;
		this.revealOverride = null;
		return setting;
	}

	private leavesShowing(path: string): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.ctx.app.workspace.iterateAllLeaves((leaf) => {
			if (markdownFile(leaf)?.path === path) leaves.push(leaf);
		});
		return leaves;
	}
}
