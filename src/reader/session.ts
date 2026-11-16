/**
 * One reading session per pair: cursor, hover and reveal state, and how it
 * is painted into whichever sections are rendered. Holds file paths, never
 * views. Owner: reader module. DESIGN.md §9.2–9.5.
 */
import { Component, MarkdownView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ATTR, CLS } from "../constants";
import type { CursorStop, GlossSource, MenardContext, PairIndex, PairModel, Side } from "../types";
import { resolveStop, sameStop, stepStop, stopAttr } from "./cursor";
import { readingPane, scrollerBox, tagFacing, tagStacked } from "./facing";
import type { ReadingPane } from "./facing";
import { inComfortBand, inViewport, isShortMove, readingLine, scrollTopToPlace } from "./geometry";
import type { ScrollerBox } from "./geometry";
import type { PositionStore } from "./positions";
import { attachPointer, linkFragments, queryAll, stopElements, stopFromTarget, unitElement, unitElements } from "./pointer";
import { attachScrollSync, ScrollWriter } from "./scroll-sync";
import { StackedGloss } from "./stacked";

export type SessionMode = "single" | "facing" | "stacked";

export interface SessionState {
	cursor: CursorStop | null;
	hover: CursorStop | null;
	/** Stacked view with reveal mode: whether the current gloss is shown. */
	revealed: boolean;
}

/** What a session asks of the manager that owns it. */
export interface SessionHost {
	/** Every leaf whose Markdown view shows `path`, in any mode. */
	leaves(path: string): readonly WorkspaceLeaf[];
	isStacked(leaf: WorkspaceLeaf): boolean;
	/** Reveal mode currently in effect for stacked views. */
	revealMode(): boolean;
	/** Where the cursor is recorded, so a reopened pair restores it. */
	positions?: PositionStore;
}

export interface MoveOptions {
	/** A held key's auto-repeat: scroll instantly. */
	repeat?: boolean;
}

interface Pane extends ReadingPane {
	side: Side;
}

interface Layout {
	mode: SessionMode;
	/** The pane whose fragments are "current": in facing mode, the one last clicked or stepped in. */
	lead: Pane | null;
	/** The facing partner pane. */
	partner: Pane | null;
}

type Role = "current" | "partner" | "hover";

interface Mark {
	side: Side;
	role: Role;
	stop: CursorStop;
}

const LINK_CLASS: Record<Role, string> = { current: CLS.current, partner: CLS.partner, hover: CLS.hover };
const UNIT_CLASS: Record<Role, string> = { current: CLS.unitCurrent, partner: CLS.unitPartner, hover: CLS.hover };
/** How long a step waits for an unrendered section to appear. */
const RENDER_WAIT_MS = 1000;

export class PairSession extends Component {
	private st: SessionState = { cursor: null, hover: null, revealed: false };
	/** Marks currently applied, by markKey. */
	private painted = new Map<string, Mark>();
	private moveTicket = 0;
	private glossFrame: number | null = null;
	private readonly writer = new ScrollWriter();
	private readonly glossSlot: StackedGloss;
	private readonly pointers = new Map<HTMLElement, Component>();
	private sync: { source: HTMLElement; target: HTMLElement; component: Component } | null = null;
	/** Leaf elements carrying a facing or stacked tag, so a leaf that moves on to another note is untagged. */
	private readonly tagged = new Set<HTMLElement>();
	/** The facing pane the reader is working in; its sentence is current and stays put, the other pane follows. */
	private leadSide: Side = "source";

	constructor(
		readonly sourcePath: string,
		readonly targetPath: string,
		private readonly ctx: MenardContext,
		private readonly pairs: PairIndex,
		gloss: GlossSource,
		private readonly host: SessionHost,
	) {
		super();
		this.glossSlot = new StackedGloss(gloss, this);
	}

	override onunload(): void {
		this.moveTicket++;
		if (this.glossFrame !== null) window.cancelAnimationFrame(this.glossFrame);
		this.st = { cursor: null, hover: null, revealed: false };
		this.paint();
		this.glossSlot.remove(null);
		this.glossSlot.hideGhost();
		this.retag(new Map());
	}

	/** The current mode, derived from which leaves show the pair (§9.2). */
	mode(): SessionMode {
		return this.layout().mode;
	}

	state(): Readonly<SessionState> {
		return this.st;
	}

	/** True when `path` is one of the pair's notes. */
	has(path: string): boolean {
		return path === this.sourcePath || path === this.targetPath;
	}

	/** Moves the cursor, paints both panes, holds the partner level or moves the gloss. */
	async setCursor(stop: CursorStop | null, options: MoveOptions = {}): Promise<void> {
		let next: CursorStop | null = null;
		if (stop) {
			const model = await this.loadModel();
			next = model ? resolveStop(model.stops(), stop) : null;
			if (!next) return;
		}
		if (sameStop(next, this.st.cursor)) return;
		const ticket = ++this.moveTicket;
		this.st = { ...this.st, cursor: next, revealed: false };
		this.paint();
		if (next) this.host.positions?.set(this.sourcePath, next);
		if (!next) {
			this.glossSlot.remove(this.layout().lead?.scroller ?? null);
			return;
		}
		await this.bringIntoView(next, options, ticket);
	}

	/**
	 * Puts the cursor back on the stop recorded when the pair was last read,
	 * and scrolls it into view, unless the reader has placed a cursor since.
	 * A recorded stop that no longer resolves is ignored.
	 */
	async restore(): Promise<boolean> {
		const saved = this.host.positions?.get(this.sourcePath);
		if (!saved || this.st.cursor) return false;
		const ticket = this.moveTicket;
		const model = await this.loadModel();
		// One frame for the other pane of a facing pair to open.
		await nextFrame();
		if (!model || ticket !== this.moveTicket || this.st.cursor || !this.layout().lead) return false;
		const stop = resolveStop(model.stops(), saved);
		if (!stop) return false;
		await this.setCursor(stop, { repeat: true });
		return true;
	}

	/** Steps by link or unit; re-enters at the reading line when the cursor is off screen. */
	async step(by: "link" | "unit", delta: 1 | -1, options: MoveOptions = {}): Promise<void> {
		const active = this.ctx.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
		if (active !== undefined && this.has(active)) this.lead(active === this.sourcePath ? "source" : "target");
		const model = await this.loadModel();
		if (!model) return;
		const stops = model.stops();
		const lead = this.layout().lead;
		const from = this.st.cursor;
		if (lead && (!from || this.isOffscreen(lead, from))) {
			const entry = this.stopAtReadingLine(lead, stops);
			if (entry && !sameStop(entry, from)) return this.setCursor(entry, options);
		}
		const next = stepStop(stops, from, by, delta);
		if (next) await this.setCursor(next, options);
	}

	setHover(stop: CursorStop | null): void {
		const model = this.pairs.peek(this.sourcePath);
		const next = stop && model ? resolveStop(model.stops(), stop) : null;
		if (sameStop(next, this.st.hover)) return;
		this.st = { ...this.st, hover: next };
		this.paint();
		const { mode, lead } = this.layout();
		if (next && model && lead && mode === "stacked" && !this.host.revealMode() && !sameStop(next, this.st.cursor)) {
			void this.glossSlot.showGhost(lead.content, model, next);
		} else {
			this.glossSlot.hideGhost();
		}
	}

	/** True when Space would reveal: stacked view, reveal mode, a cursor, gloss still concealed. */
	canReveal(): boolean {
		return this.st.cursor !== null && !this.st.revealed && this.host.revealMode() && this.mode() === "stacked";
	}

	/** Makes `side` the facing pane whose sentence is current. */
	lead(side: Side): void {
		if (side === this.leadSide) return;
		this.leadSide = side;
		this.paint();
	}

	reveal(): boolean {
		const lead = this.layout().lead;
		if (!this.canReveal() || !lead) return false;
		this.st = { ...this.st, revealed: true };
		this.glossSlot.reveal(lead.scroller);
		return true;
	}

	/** Re-applies state classes (and the gloss) to a freshly rendered section. */
	sectionRendered(path: string, el: HTMLElement): void {
		const side: Side = path === this.sourcePath ? "source" : "target";
		for (const mark of this.painted.values()) if (mark.side === side) applyMark(el, mark, true);
		const cursor = this.st.cursor;
		if (side === "source" && cursor && this.mode() === "stacked" && stopElements(el, cursor).length > 0) this.scheduleGloss();
	}

	/** Brings tags, listeners, scroll sync, gloss and paint in line with the current layout. */
	refresh(): void {
		const layout = this.layout();
		const tags = new Map<HTMLElement, Side | "stacked">();
		if (layout.mode === "stacked" && layout.lead) tags.set(layout.lead.leafEl, "stacked");
		for (const pane of layout.mode === "facing" ? [layout.lead, layout.partner] : []) if (pane) tags.set(pane.leafEl, pane.side);
		this.retag(tags);
		this.attachPointers();
		this.updateSync(layout);
		this.paint();
		this.reapply();
		if (layout.mode !== "stacked") {
			this.glossSlot.remove(null);
			this.glossSlot.hideGhost();
		} else if (this.st.cursor) {
			this.scheduleGloss();
		}
	}

	/** The pair's model was rebuilt: keep the cursor where it still exists and repaint. */
	modelChanged(): void {
		const model = this.pairs.peek(this.sourcePath);
		const keep = (stop: CursorStop | null): CursorStop | null =>
			stop && model ? (resolveStop(model.stops(), stop) ?? resolveStop(model.stops(), { unit: stop.unit, link: null })) : null;
		const cursor = keep(this.st.cursor);
		// A cursor the rebuild moved is a cursor move: the gloss conceals again (§9.5).
		this.st = { cursor, hover: null, revealed: this.st.revealed && sameStop(cursor, this.st.cursor) };
		this.glossSlot.hideGhost();
		this.paint();
		this.reapply();
		if (this.st.cursor && this.mode() === "stacked") this.scheduleGloss();
		else this.glossSlot.remove(null);
	}

	/** Applies exactly `tags` to leaf elements, clearing those tagged before and not now. */
	private retag(tags: ReadonlyMap<HTMLElement, Side | "stacked">): void {
		for (const el of new Set([...this.tagged, ...tags.keys()])) {
			const tag = tags.get(el);
			tagFacing(el, tag === "source" || tag === "target" ? tag : null);
			tagStacked(el, tag === "stacked");
			if (tag) this.tagged.add(el);
			else this.tagged.delete(el);
		}
	}

	// ─── Layout ─────────────────────────────────────────────────────────────

	private layout(): Layout {
		const panes = this.panes();
		const sources = panes.filter((p) => p.side === "source" && p.visible());
		const targets = panes.filter((p) => p.side === "target" && p.visible());
		const stacked = sources.find((p) => this.host.isStacked(p.leaf));
		if (stacked) return { mode: "stacked", lead: stacked, partner: null };
		for (const source of sources) {
			const target = targets.find((t) => t.leaf.getContainer() === source.leaf.getContainer());
			if (!target) continue;
			return this.leadSide === "target" ? { mode: "facing", lead: target, partner: source } : { mode: "facing", lead: source, partner: target };
		}
		return { mode: "single", lead: sources[0] ?? targets[0] ?? panes[0] ?? null, partner: null };
	}

	/** Every reading pane of the pair; panes in editing mode are paused and left out. */
	private panes(): Pane[] {
		const panes: Pane[] = [];
		for (const leaf of this.allLeaves()) {
			const pane = this.paneOf(leaf);
			if (pane) panes.push(pane);
		}
		return panes;
	}

	private paneOf(leaf: WorkspaceLeaf): Pane | null {
		const pane = readingPane(leaf);
		if (!pane || !this.has(pane.path)) return null;
		return { ...pane, side: pane.path === this.sourcePath ? "source" : "target" };
	}

	private allLeaves(): WorkspaceLeaf[] {
		return [...this.host.leaves(this.sourcePath), ...this.host.leaves(this.targetPath)];
	}

	private loadModel(): Promise<PairModel | null> {
		const cached = this.pairs.peek(this.sourcePath);
		if (cached) return Promise.resolve(cached);
		const file = this.ctx.app.vault.getFileByPath(this.sourcePath);
		return file ? this.pairs.load(file) : Promise.resolve(null);
	}

	// ─── Painting ───────────────────────────────────────────────────────────

	/** Diffs the marks the state calls for against those applied, and toggles only the difference. */
	private paint(): void {
		const lead = this.layout().lead?.side ?? "source";
		const next = new Map<string, Mark>();
		const add = (mark: Mark): void => void next.set(markKey(mark), mark);
		const { cursor, hover } = this.st;
		if (cursor) {
			add({ side: lead, role: "current", stop: cursor });
			add({ side: lead === "source" ? "target" : "source", role: "partner", stop: cursor });
		}
		if (hover) {
			add({ side: "source", role: "hover", stop: hover });
			add({ side: "target", role: "hover", stop: hover });
		}
		const panes = this.panes();
		for (const [key, mark] of this.painted) {
			if (next.has(key)) continue;
			for (const pane of panes) if (pane.side === mark.side) applyMark(pane.content, mark, false);
		}
		for (const [key, mark] of next) {
			if (this.painted.has(key)) continue;
			for (const pane of panes) if (pane.side === mark.side) applyMark(pane.content, mark, true);
		}
		this.painted = next;
	}

	/** Applies every current mark again, for panes that appeared since the last paint. Idempotent. */
	private reapply(): void {
		const panes = this.panes();
		for (const mark of this.painted.values()) {
			for (const pane of panes) if (pane.side === mark.side) applyMark(pane.content, mark, true);
		}
	}

	// ─── Moving ─────────────────────────────────────────────────────────────

	private async bringIntoView(stop: CursorStop, options: MoveOptions, ticket: number): Promise<void> {
		const { mode, lead, partner } = this.layout();
		const model = this.pairs.peek(this.sourcePath);
		if (!lead || !model) return;
		await Promise.all([this.ensureRendered(lead, stop, model), partner ? this.ensureRendered(partner, stop, model) : null]);
		if (ticket !== this.moveTicket) return;
		if (mode === "stacked") {
			await this.showGloss(lead, model, stop);
			if (ticket !== this.moveTicket) return;
		}
		await nextFrame();
		if (ticket !== this.moveTicket) return;
		this.holdLevel(stop, lead, mode === "facing" ? partner : null, options);
	}

	/**
	 * Held level (§9.3): one read of both panes, then one write. The lead pane
	 * moves only when the current sentence left the comfort band; the partner
	 * is placed at the same height.
	 */
	private holdLevel(stop: CursorStop, lead: Pane, partner: Pane | null, options: MoveOptions): void {
		const own = stopElements(lead.content, stop)[0];
		if (!own) return;
		const ownBox = scrollerBox(lead.scroller);
		const ownTop = own.getBoundingClientRect().top;
		const other = partner ? stopElements(partner.content, stop)[0] : undefined;
		const partnerBox = partner && other ? scrollerBox(partner.scroller) : null;
		const partnerTop = other?.getBoundingClientRect().top ?? 0;

		const ownNext = inComfortBand(ownBox, ownTop) ? ownBox.scrollTop : scrollTopToPlace(ownBox, ownTop, readingLine(ownBox));
		const level = ownTop - (ownNext - ownBox.scrollTop);

		this.scrollTo(lead.scroller, ownBox, ownNext, options);
		if (partner && partnerBox) this.scrollTo(partner.scroller, partnerBox, scrollTopToPlace(partnerBox, partnerTop, level), options);
	}

	private scrollTo(scroller: HTMLElement, box: ScrollerBox, top: number, options: MoveOptions): void {
		const smooth = !options.repeat && !prefersReducedMotion() && isShortMove(box, top);
		this.writer.write(scroller, top, smooth);
	}

	/** Scrolls an unrendered unit into the DOM by its line and waits for it; null on timeout. */
	private async ensureRendered(pane: Pane, stop: CursorStop, model: PairModel): Promise<HTMLElement | null> {
		const present = unitElement(pane.content, stop.unit);
		if (present) return present;
		const line = unitLine(model, stop, pane.side);
		if (line === null) return null;
		pane.applyScroll(line);
		return waitForElement(pane.content, () => unitElement(pane.content, stop.unit), RENDER_WAIT_MS);
	}

	private isOffscreen(pane: Pane, stop: CursorStop): boolean {
		const el = stopElements(pane.content, stop)[0];
		if (!el) return true;
		const box = scrollerBox(pane.scroller);
		const rect = el.getBoundingClientRect();
		const spansViewport = rect.top < box.top && rect.bottom > box.top + box.height;
		return !inViewport(box, rect.top) && !inViewport(box, rect.bottom) && !spansViewport;
	}

	/** The first rendered stop that reaches the reading line, in document order. */
	private stopAtReadingLine(pane: Pane, stops: readonly CursorStop[]): CursorStop | null {
		const line = readingLine(scrollerBox(pane.scroller));
		for (const unit of queryAll(pane.content, `[${ATTR.unit}]`)) {
			if (unit.getBoundingClientRect().bottom < line) continue;
			const fragments = queryAll(unit, `[${ATTR.link}]`);
			for (const el of fragments.length > 0 ? fragments : [unit]) {
				if (el.getBoundingClientRect().bottom < line) continue;
				const stop = stopFromTarget(el);
				const resolved = stop ? resolveStop(stops, stop) : null;
				if (resolved) return resolved;
			}
		}
		return null;
	}

	// ─── Stacked gloss ──────────────────────────────────────────────────────

	/** Places the gloss on the next frame, once, after sections settle. */
	private scheduleGloss(): void {
		if (this.glossFrame !== null) return;
		this.glossFrame = window.requestAnimationFrame(() => {
			this.glossFrame = null;
			const { mode, lead } = this.layout();
			const model = this.pairs.peek(this.sourcePath);
			const cursor = this.st.cursor;
			if (mode !== "stacked" || !lead || !model || !cursor) return;
			void this.showGloss(lead, model, cursor);
		});
	}

	/** Shows the gloss, concealed in reveal mode; a reveal that came while it rendered applies once it is in place. */
	private async showGloss(lead: Pane, model: PairModel, stop: CursorStop): Promise<void> {
		await this.glossSlot.show(lead.content, lead.scroller, model, stop, this.host.revealMode() && !this.st.revealed);
		if (this.st.revealed && sameStop(this.st.cursor, stop)) this.glossSlot.reveal(lead.scroller);
	}

	// ─── Listeners ──────────────────────────────────────────────────────────

	private attachPointers(): void {
		const live = new Set(this.panes().map((p) => p.content));
		for (const [el, component] of this.pointers) {
			if (live.has(el)) continue;
			this.removeChild(component);
			this.pointers.delete(el);
		}
		for (const el of live) {
			if (this.pointers.has(el)) continue;
			const component = this.addChild(new Component());
			attachPointer(component, el, {
				jump: (stop) => {
					const side = this.panes().find((pane) => pane.content === el)?.side;
					if (side) this.lead(side);
					void this.setCursor(stop);
				},
				hover: (stop) => this.setHover(stop),
				hoverEnabled: () => this.ctx.settings().hoverPartner,
			});
			this.pointers.set(el, component);
		}
	}

	private updateSync(layout: Layout): void {
		const facing = layout.mode === "facing" ? [layout.lead, layout.partner] : [];
		const source = facing.find((pane) => pane?.side === "source") ?? null;
		const target = facing.find((pane) => pane?.side === "target") ?? null;
		if (this.sync && this.sync.source === source?.scroller && this.sync.target === target?.scroller) return;
		if (this.sync) this.removeChild(this.sync.component);
		this.sync = null;
		if (!source || !target) return;
		const component = this.addChild(new Component());
		attachScrollSync(component, [source, target], () => this.pairs.peek(this.sourcePath), this.writer);
		this.sync = { source: source.scroller, target: target.scroller, component };
	}
}

function markKey(mark: Mark): string {
	return `${mark.side}|${mark.role}|${stopAttr(mark.stop)}`;
}

/**
 * Toggles a mark's class on its fragments in `root`; on the unit element
 * instead for a whole-unit stop or when the link's spans are missing.
 * Removal clears both, since a section may have been rewrapped since.
 * Touches an attribute only when it changes.
 */
function applyMark(root: HTMLElement, mark: Mark, on: boolean): void {
	const fragments = linkFragments(root, mark.stop);
	const units = on && fragments.length > 0 ? [] : unitElements(root, mark.stop.unit);
	for (const el of fragments) setMark(el, LINK_CLASS[mark.role], mark.role === "current", on);
	for (const el of units) setMark(el, UNIT_CLASS[mark.role], mark.role === "current", on);
}

function setMark(el: HTMLElement, cls: string, ariaCurrent: boolean, on: boolean): void {
	if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
	if (!ariaCurrent) return;
	if (on && el.getAttribute("aria-current") !== "true") el.setAttribute("aria-current", "true");
	else if (!on && el.hasAttribute("aria-current")) el.removeAttribute("aria-current");
}

/** The unit's first line on `side`, from the scroll anchors or, for a one-sided unit, its block. */
function unitLine(model: PairModel, stop: CursorStop, side: Side): number | null {
	const anchor = model.anchors().find((a) => a.key === stop.unit);
	if (anchor) return anchor[side].start;
	const unit = model.unit(stop.unit);
	const block = side === "source" ? unit?.source : unit?.target;
	return block ? block.lines.start : null;
}

function waitForElement(root: HTMLElement, find: () => HTMLElement | null, timeoutMs: number): Promise<HTMLElement | null> {
	return new Promise((resolve) => {
		let timer: number | null = null;
		const observer = new MutationObserver(() => {
			const el = find();
			if (el) finish(el);
		});
		const finish = (el: HTMLElement | null): void => {
			observer.disconnect();
			if (timer !== null) window.clearTimeout(timer);
			resolve(el);
		};
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR.unit] });
		timer = window.setTimeout(() => finish(null), timeoutMs);
	});
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function prefersReducedMotion(): boolean {
	return activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
