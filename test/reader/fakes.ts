/**
 * Fakes for the reader tests: Obsidian's DOM helpers on happy-dom, a fake
 * PairModel, PairIndex and GlossSource, a fake workspace of reading-view
 * leaves, and pane markup in the render module's DOM contract. Never
 * imports the render or align implementations.
 */
import { Component, Events, MarkdownView, TFile } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import { vi } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { stopAttr } from "../../src/reader/cursor";
import type {
	CursorStop,
	GlossSource,
	MenardContext,
	MenardSettings,
	PairIndex,
	PairLink,
	PairModel,
	PairUnit,
	ScrollAnchor,
	Side,
	UnitKey,
} from "../../src/types";

// ─── Obsidian DOM helpers ───────────────────────────────────────────────────

/** Installs the globals Obsidian adds to the DOM, as far as the reader uses them. */
export function installObsidianDom(): void {
	const proto = Node.prototype as unknown as Record<string, unknown>;
	proto.instanceOf = function (this: Node, type: abstract new () => unknown) {
		return Object.prototype.isPrototypeOf.call(type.prototype, this);
	};
	(HTMLElement.prototype as unknown as Record<string, unknown>).isShown = function (this: HTMLElement) {
		return this.isConnected && this.closest("[hidden]") === null;
	};
	// Under happy-dom, `window` is the global object, so these become bare globals.
	const g = window as unknown as Record<string, unknown>;
	g.activeWindow = window;
	g.activeDocument = document;
	g.createSpan = (o?: { cls?: string; attr?: Record<string, string>; text?: string }) => {
		const el = document.createElement("span");
		if (o?.cls) el.className = o.cls;
		for (const [k, v] of Object.entries(o?.attr ?? {})) el.setAttribute(k, v);
		if (o?.text) el.textContent = o.text;
		return el;
	};
	// Frames run as microtasks, so `await settle()` flushes them.
	let frameId = 0;
	window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
		const id = ++frameId;
		queueMicrotask(() => cb(0));
		return id;
	};
	window.cancelAnimationFrame = () => {};
	window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
}

/** Lets queued frames and promise chains run. */
export async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ─── Markup ─────────────────────────────────────────────────────────────────

type Child = Node | string;

/** Tiny element builder: h("p", { "data-menard-unit": "p1" }, "text", h("em", {}, "x")). */
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	for (const child of children) el.append(child);
	return el;
}

/** A wrapped sentence fragment: span.menard-s[data-menard-link="p1.2"]. */
export function frag(link: string, ...children: Child[]): HTMLElement {
	return h("span", { class: CLS.sentence, [ATTR.link]: link }, ...children);
}

/** A reading-view section holding one unit element. */
export function section(unit: HTMLElement): HTMLElement {
	return h("div", { class: "markdown-preview-section-item" }, unit);
}

export function unitEl(tag: string, key: UnitKey, ...children: Child[]): HTMLElement {
	return h(tag, { [ATTR.unit]: key }, ...children);
}

/** Spanish source: academic prose with abbreviations, citations, footnotes, « » and “ ” quotations, italics and links. */
export function spanishSections(): HTMLElement[] {
	return [
		section(
			unitEl(
				"p",
				"p1",
				frag("p1.1", "Según Ruiz (2002, p. 14), el Sr. Almotásim «no existe fuera del texto»."),
				" ",
				frag("p1.2", "Cf. la reseña de Borges, donde la "),
				h("em", {}, frag("p1.2", "búsqueda")),
				frag("p1.2", " se vuelve “infinita”."),
				h("sup", { class: "footnote-ref", [ATTR.link]: "p1.2" }, h("a", { href: "#fn-1" }, "1")),
				" ",
				frag("p1.3", "Véase ", h("a", { class: "internal-link", href: "@borgesversiones1932" }, "Las versiones homéricas"), ", passim."),
			),
		),
		section(
			unitEl(
				"p",
				"p2",
				frag("p2.1", "El narrador, i. e. el reseñista, finge una edición de Bombay."),
				" ",
				frag("p2.2", "Nada sabemos del Dr. Bahadur, salvo su «novela policial»."),
			),
		),
		section(unitEl("ul", "p3", h("li", {}, "Borges, J. L. (1936). «El acercamiento a Almotásim»."))),
		section(unitEl("p", "p4", "Texto sin mapa: la alineación se perdió tras la edición del Sr. Gómez.")),
	];
}

/** English translation of the same units. */
export function englishSections(): HTMLElement[] {
	return [
		section(
			unitEl(
				"p",
				"p1",
				frag("p1.1", "According to Ruiz (2002, p. 14), Mr. Almotásim “does not exist outside the text.”"),
				" ",
				frag("p1.2", "See Borges's review, where the "),
				h("em", {}, frag("p1.2", "search")),
				frag("p1.2", " becomes “infinite.”"),
				" ",
				frag("p1.3", "See ", h("a", { class: "internal-link", href: "@borgesversiones1932" }, "The Homeric Versions"), ", passim."),
			),
		),
		section(
			unitEl(
				"p",
				"p2",
				frag("p2.1", "The narrator, i.e. the reviewer, invents a Bombay edition."),
				" ",
				frag("p2.2", "We know nothing of Dr. Bahadur but his “detective novel.”"),
			),
		),
		section(unitEl("ul", "p3", h("li", {}, "Borges, J. L. (1936). “The Approach to Al-Mu'tasim.”"))),
		section(unitEl("p", "p4", "Unmapped text: the alignment was lost after Mr. Gómez's edit.")),
	];
}

// ─── Geometry stubs ─────────────────────────────────────────────────────────

export interface FakeScroller {
	el: HTMLElement;
	/** Positions an element at a document y inside the scroller's content. */
	place(el: Element, docTop: number, height: number): void;
	scrollTo: ReturnType<typeof vi.fn>;
}

/** Makes `el` a scroller with a viewport at client `top` of `height`, and settable scrollTop. */
export function fakeScroller(el: HTMLElement, top = 0, height = 1000, scrollHeight = 10000): FakeScroller {
	let scrollTop = 0;
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.min(Math.max(v, 0), scrollHeight - height);
		},
	});
	Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height });
	Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
	el.getBoundingClientRect = () => rect(top, height);
	const scrollTo = vi.fn((options: ScrollToOptions) => {
		el.scrollTop = options.top ?? scrollTop;
	});
	el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
	return {
		el,
		scrollTo,
		place: (child, docTop, h) => {
			child.getBoundingClientRect = () => rect(top + docTop - el.scrollTop, h);
		},
	};
}

export function rect(top: number, height: number): DOMRect {
	return { top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) };
}

/** Lays out every unit element (and its fragments, one line of 24 px each) top to bottom from `start`, `gap` apart. */
export function layout(scroller: FakeScroller, start = 0, unitHeight = 200, gap = 40): void {
	let y = start;
	for (const unit of Array.from(scroller.el.querySelectorAll(`[${ATTR.unit}]`))) {
		scroller.place(unit, y, unitHeight);
		let line = y;
		const seen = new Map<string, number>();
		for (const f of Array.from(unit.querySelectorAll(`[${ATTR.link}]`))) {
			const key = f.getAttribute(ATTR.link) ?? "";
			const at = seen.get(key) ?? line;
			if (!seen.has(key)) {
				seen.set(key, line);
				line += 48;
			}
			scroller.place(f, at, 24);
		}
		y += unitHeight + gap;
	}
}

// ─── Pair model and index ───────────────────────────────────────────────────

export interface UnitSpec {
	key: UnitKey;
	/** Number of links with a source side; null for a unit without a usable map. */
	links: number | null;
	/** First line on each side; a side's line is null for a one-sided unit. */
	source: number | null;
	target: number | null;
}

export const SOURCE_PATH = "Collections/Texts/@ruizalmotasim.md";
export const TARGET_PATH = "Collections/Texts/@ruizalmotasim (EN).md";

export const DEFAULT_UNITS: UnitSpec[] = [
	{ key: "p1", links: 3, source: 10, target: 12 },
	{ key: "p2", links: 2, source: 14, target: 17 },
	{ key: "p3", links: null, source: 18, target: 21 },
	{ key: "p4", links: null, source: 22, target: 25 },
	{ key: "p5", links: 2, source: 400, target: 420 },
];

export function fakeModel(units: UnitSpec[] = DEFAULT_UNITS, version = 1): PairModel {
	const stops = units.flatMap((u): CursorStop[] =>
		u.links === null ? [{ unit: u.key, link: null }] : Array.from({ length: u.links }, (_, i) => ({ unit: u.key, link: i + 1 })),
	);
	const block = (line: number | null) => (line === null ? null : ({ lines: { start: line, end: line + 1 } } as PairUnit["source"]));
	const pairUnits: PairUnit[] = units.map((u) => ({
		key: u.key,
		kind: u.links === null ? "list" : "paragraph",
		source: block(u.source),
		target: block(u.target),
		map: null,
		pending: null,
	}));
	const anchors: ScrollAnchor[] = units
		.filter((u) => u.source !== null && u.target !== null)
		.map((u) => ({ key: u.key, source: { start: u.source ?? 0, end: (u.source ?? 0) + 1 }, target: { start: u.target ?? 0, end: (u.target ?? 0) + 1 } }));
	return {
		sourcePath: SOURCE_PATH,
		targetPath: TARGET_PATH,
		languages: { source: "es", target: "en" },
		version,
		units: pairUnits,
		problems: [],
		unit: (key) => pairUnits.find((u) => u.key === key),
		unitAtLine: () => undefined,
		stops: () => stops,
		anchors: () => anchors,
	};
}

/** A TFile for a vault path (the mock takes the path its typings leave out). */
export function fakeFile(path: string): TFile {
	return new (TFile as unknown as new (path: string) => TFile)(path);
}

export class FakePairIndex implements PairIndex {
	readonly source = fakeFile(SOURCE_PATH);
	readonly target = fakeFile(TARGET_PATH);
	private listeners = new Set<(sourcePath: string) => void>();

	constructor(public model: PairModel | null = fakeModel()) {}

	get pair(): PairLink {
		return { source: this.source, target: this.target };
	}

	resolve(file: TFile): { pair: PairLink; side: Side } | null {
		if (file.path === SOURCE_PATH) return { pair: this.pair, side: "source" };
		if (file.path === TARGET_PATH) return { pair: this.pair, side: "target" };
		return null;
	}

	mayBePair(path: string): boolean {
		return path === SOURCE_PATH || path === TARGET_PATH;
	}

	load(file: TFile): Promise<PairModel | null> {
		return Promise.resolve(this.resolve(file) ? this.model : null);
	}

	peek(path: string): PairModel | null {
		return this.mayBePair(path) ? this.model : null;
	}

	onChange(listener: (sourcePath: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	rebuild(model: PairModel): void {
		this.model = model;
		for (const listener of this.listeners) listener(SOURCE_PATH);
	}
}

export class FakeGlossSource implements GlossSource {
	readonly calls: string[] = [];
	/** Stops whose render owner was unloaded, in order. */
	readonly unloaded: string[] = [];
	/** Stops (by attr) that have nothing to show. */
	readonly empty = new Set<string>();

	render(_model: PairModel, stop: CursorStop, into: HTMLElement, owner: Component): Promise<boolean> {
		const attr = stopAttr(stop);
		this.calls.push(attr);
		const child = owner.addChild(new Component());
		child.onunload = () => void this.unloaded.push(attr);
		if (this.empty.has(attr)) return Promise.resolve(false);
		into.textContent = `EN ${attr}`;
		return Promise.resolve(true);
	}
}

// ─── Workspace ──────────────────────────────────────────────────────────────

export class FakeView extends MarkdownView {
	mode: "preview" | "source" = "preview";
	override containerEl: HTMLElement;
	readonly content: HTMLElement;
	readonly scroller: FakeScroller;
	readonly applyScroll = vi.fn<(line: number) => void>();

	constructor(
		override leaf: WorkspaceLeaf,
		file: TFile | null,
		sections: HTMLElement[],
	) {
		super(leaf);
		this.file = file;
		const scrollerEl = h("div", { class: "markdown-preview-view" }, h("div", { class: "markdown-preview-sizer" }, ...sections));
		this.content = h("div", { class: "markdown-reading-view" }, scrollerEl);
		this.containerEl = h("div", { class: "workspace-leaf-content" }, this.content);
		this.scroller = fakeScroller(scrollerEl);
		layout(this.scroller);
		this.previewMode = { containerEl: this.content, applyScroll: this.applyScroll, getScroll: () => 0 } as unknown as MarkdownView["previewMode"];
	}

	override getMode(): "preview" | "source" {
		return this.mode;
	}

	sizer(): HTMLElement {
		return this.scroller.el.firstElementChild as HTMLElement;
	}
}

export interface FakeLeaf {
	view: FakeView;
	container: object;
	getContainer(): object;
	openFile: ReturnType<typeof vi.fn>;
}

export class FakeWorkspace extends Events {
	readonly leaves: FakeLeaf[] = [];
	readonly containerEl = h("div", { class: "workspace" });
	active: FakeLeaf | null = null;
	readonly mainWindow = {};
	split: FakeLeaf | null = null;
	readonly setActiveLeaf = vi.fn((leaf: FakeLeaf) => {
		this.active = leaf;
	});
	readonly getLeaf = vi.fn((_type?: string, _direction?: string): FakeLeaf => {
		const leaf = this.addLeaf(null, []);
		this.split = leaf;
		return leaf;
	});

	constructor() {
		super();
		document.body.append(this.containerEl);
	}

	addLeaf(file: TFile | null, sections: HTMLElement[], container: object = this.mainWindow): FakeLeaf {
		const leaf = { container, getContainer: () => leaf.container } as FakeLeaf;
		leaf.view = new FakeView(leaf as unknown as WorkspaceLeaf, file, sections);
		leaf.openFile = vi.fn(async (next: TFile, state?: { state?: { mode?: string } }) => {
			leaf.view.file = next;
			if (state?.state?.mode === "preview") leaf.view.mode = "preview";
		});
		this.containerEl.append(leaf.view.containerEl);
		this.leaves.push(leaf);
		return leaf;
	}

	iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
		for (const leaf of this.leaves) callback(leaf as unknown as WorkspaceLeaf);
	}

	getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
		const view = this.active?.view;
		return view instanceof type ? view : null;
	}
}

export const READER_SETTINGS: Pick<MenardSettings, "readingKeys" | "hoverPartner" | "revealMode"> = {
	readingKeys: true,
	hoverPartner: true,
	revealMode: false,
};

export interface FakeEnv {
	app: App;
	workspace: FakeWorkspace;
	ctx: MenardContext;
	owner: Component;
	settings: MenardSettings;
	pairs: FakePairIndex;
	gloss: FakeGlossSource;
}

export function fakeEnv(settings: Partial<MenardSettings> = {}): FakeEnv {
	const workspace = new FakeWorkspace();
	const pairs = new FakePairIndex();
	const files = new Map([pairs.source, pairs.target].map((f) => [f.path, f]));
	const app = { workspace, vault: { getFileByPath: (path: string) => files.get(path) ?? null } } as unknown as App;
	const merged = { ...READER_SETTINGS, ...settings } as MenardSettings;
	const owner = new Component();
	owner.load();
	return { app, workspace, owner, settings: merged, pairs, gloss: new FakeGlossSource(), ctx: { app, owner, settings: () => merged } };
}

/** Source on the left, translation on the right, in one window. */
export function facingLeaves(env: FakeEnv): { source: FakeLeaf; target: FakeLeaf } {
	const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
	const target = env.workspace.addLeaf(env.pairs.target, englishSections());
	env.workspace.active = source;
	return { source, target };
}

/** Elements carrying the cursor class, as link attributes or unit keys. */
export function marked(root: HTMLElement, cls: string): string[] {
	return Array.from(root.querySelectorAll(`.${cls}`)).map((el) => el.getAttribute(ATTR.link) ?? el.getAttribute(ATTR.unit) ?? "?");
}
