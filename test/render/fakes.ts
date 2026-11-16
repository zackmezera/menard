/**
 * Hand-built stand-ins for the vault module's PairIndex, the align module's
 * PairModel, Obsidian's App and the post-processor context. Only what the
 * render module reads is implemented.
 */
import { vi } from "vitest";
import { Component, Events, TFile, type App, type MarkdownPostProcessorContext } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type {
	Block,
	CursorStop,
	MapLink,
	MenardContext,
	MenardSettings,
	PairIndex,
	PairModel,
	PairUnit,
	ScrollAnchor,
	Side,
	SideSig,
	UnitKind,
} from "../../src/types";

export const SOURCE_PATH = "Texts/Quijote.md";

/** A TFile at `path`; the test mock's constructor takes the path, the real typings do not. */
export function fileAt(path: string): TFile {
	return new (TFile as unknown as new (path: string) => TFile)(path);
}

export const TARGET_PATH = "Texts/Quijote (EN).md";

/** Parses the links of a map line like "%%menard:1 p1 33.myfp/46.6ton%%" (test-only, no validation). */
export function linksOf(mapLine: string): MapLink[] {
	const body = mapLine.replace(/^%%menard:1 \S+ /, "").replace(/%%$/, "");
	const side = (text: string): SideSig | null => {
		if (text === "-") return null;
		const [count, hash] = text.split(".");
		return { count: Number(count), hash: hash ?? "" };
	};
	return body.split(" ").map((link) => {
		const loose = link.endsWith("?");
		const [src, tgt] = link.replace(/\?$/, "").split("/");
		return { src: side(src ?? "-"), tgt: side(tgt ?? "-"), loose };
	});
}

export function block(kind: Block["kind"], start: number, end: number, id: string | null = null): Block {
	return { kind, region: "text", lines: { start, end }, raw: "", body: "", id, idStyle: id ? "trailing" : null, idLine: id ? end - 1 : null };
}

export interface UnitSpec {
	key: string;
	kind?: UnitKind;
	source: Block | null;
	target: Block | null;
	links?: MapLink[];
	/** Target line of the unit's map, for unitAtLine. */
	mapLine?: number;
}

export function fakeModel(specs: readonly UnitSpec[], version = 1): PairModel {
	const units: PairUnit[] = specs.map((s) => ({
		key: s.key,
		kind: s.kind ?? "paragraph",
		source: s.source,
		target: s.target,
		map: s.links ? { kind: "map", key: s.key, links: s.links } : null,
		pending: null,
	}));
	return {
		sourcePath: SOURCE_PATH,
		targetPath: TARGET_PATH,
		languages: { source: "es", target: "en" },
		version,
		units,
		problems: [],
		unit: (key) => units.find((u) => u.key === key),
		unitAtLine: (side: Side, line: number) =>
			units.find((u, i) => {
				const b = side === "source" ? u.source : u.target;
				if (side === "target" && specs[i]?.mapLine === line) return true;
				if (!b) return false;
				const last = b.idStyle === "own-line" && b.idLine !== null ? b.idLine : b.lines.end - 1;
				return line >= b.lines.start && line <= last;
			}),
		stops: (): CursorStop[] => units.map((u) => ({ unit: u.key, link: null })),
		anchors: (): ScrollAnchor[] => [],
	};
}

export class FakePairs implements PairIndex {
	loads = 0;
	readonly listeners = new Set<(sourcePath: string) => void>();
	constructor(public model: PairModel | null) {}

	/** Swaps the model and tells listeners, as a rebuild does. */
	rebuild(model: PairModel | null): void {
		this.model = model;
		for (const listener of this.listeners) listener(SOURCE_PATH);
	}

	resolve(file: TFile): { pair: { source: TFile; target: TFile }; side: Side } | null {
		if (!this.model) return null;
		const side: Side | null = file.path === SOURCE_PATH ? "source" : file.path === TARGET_PATH ? "target" : null;
		return side ? { pair: { source: fileAt(SOURCE_PATH), target: fileAt(TARGET_PATH) }, side } : null;
	}

	mayBePair(path: string): boolean {
		return path === SOURCE_PATH || path === TARGET_PATH;
	}

	load(file: TFile): Promise<PairModel | null> {
		this.loads++;
		return Promise.resolve(this.resolve(file) ? this.model : null);
	}

	peek(): PairModel | null {
		return this.model;
	}

	onChange(listener: (sourcePath: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export interface FakeApp {
	app: App;
	files: Map<string, string>;
	openLinkText: ReturnType<typeof vi.fn>;
	metadataCache: Events;
}

export function fakeApp(files: Record<string, string> = {}): FakeApp {
	const store = new Map(Object.entries(files));
	const openLinkText = vi.fn(() => Promise.resolve());
	const metadataCache = new Events();
	const app = {
		vault: {
			getFileByPath: (path: string) => (store.has(path) ? fileAt(path) : null),
			cachedRead: (file: TFile) => Promise.resolve(store.get(file.path) ?? ""),
		},
		workspace: { openLinkText },
		metadataCache,
	} as unknown as App;
	return { app, files: store, openLinkText, metadataCache };
}

export function fakeContext(app: App, settings: Partial<MenardSettings> = {}): MenardContext {
	const current: MenardSettings = { ...DEFAULT_SETTINGS, ...settings };
	return { app, settings: () => current, owner: new Component() };
}

export interface FakeSection {
	ctx: MarkdownPostProcessorContext;
	addChild: ReturnType<typeof vi.fn>;
}

/** A post-processor context whose section spans lines [lineStart, lineEnd] of `text`. */
export function fakeSection(options: {
	sourcePath: string;
	text: string;
	lineStart: number;
	lineEnd?: number;
	frontmatter?: Record<string, unknown> | null;
	sectionInfo?: boolean;
	containerEl?: HTMLElement;
}): FakeSection {
	const addChild = vi.fn();
	const frontmatter =
		options.frontmatter !== undefined
			? options.frontmatter
			: options.sourcePath === TARGET_PATH
				? { source: "[[Quijote]]" }
				: { translation: "[[Quijote (EN)]]" };
	const ctx = {
		docId: "doc",
		sourcePath: options.sourcePath,
		frontmatter,
		addChild,
		containerEl: options.containerEl,
		getSectionInfo: () =>
			options.sectionInfo === false ? null : { text: options.text, lineStart: options.lineStart, lineEnd: options.lineEnd ?? options.lineStart },
	} as unknown as MarkdownPostProcessorContext;
	return { ctx, addChild };
}
