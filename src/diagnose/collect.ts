/**
 * Samples the workspace for the problem report: the active pair, its model,
 * and the DOM and renderer state of every open pane of the pair. Read-only:
 * it never scrolls, renders, tags or writes.
 */
import { MarkdownView, Platform, apiVersion } from "obsidian";
import type { App } from "obsidian";
import { ATTR, CLS } from "../constants";
import type { MenardSettings, PairIndex, ReaderApi, Side } from "../types";
import type { PaneSample, ReportInput, SectionSample } from "./report";

/** Text kept from the DOM before the report decides whether to keep a snippet. */
const RAW_TEXT_CHARS = 80;

export interface CollectDeps {
	app: App;
	pairs: PairIndex;
	reader: ReaderApi;
	settings: MenardSettings;
	pluginVersion: string;
}

/** Everything buildReport needs except the snippet choice. */
export type Collected = Omit<ReportInput, "snippets">;

export async function collect(deps: CollectDeps): Promise<Collected> {
	const { app, pairs, reader } = deps;
	const active = app.workspace.getActiveFile();
	const resolved = active ? pairs.resolve(active) : null;
	const pair = resolved ? { source: resolved.pair.source.path, target: resolved.pair.target.path } : null;
	const model = active && resolved ? await pairs.load(active) : null;
	const sideOf = (path: string): Side | null => (pair?.source === path ? "source" : pair?.target === path ? "target" : null);

	const panes: PaneSample[] = [];
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) continue;
		const side = sideOf(view.file.path);
		const tagged = view.containerEl.hasAttribute(ATTR.role) || view.containerEl.hasClass(CLS.stacked);
		if (side === null && view.file !== active && !tagged) continue;
		panes.push(samplePane(view, side));
	}

	return {
		generatedAt: new Date().toISOString(),
		env: { pluginVersion: deps.pluginVersion, obsidianVersion: apiVersion, platform: platformName() },
		settings: deps.settings,
		activePath: active?.path ?? null,
		pair,
		model,
		panes,
		session: { active: reader.hasActiveSession(), currentUnit: reader.currentUnit()?.key ?? null },
	};
}

function platformName(): string {
	const os = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "unknown";
	return `${os}, ${Platform.isMobile ? "mobile" : "desktop"}`;
}

const rawText = (el: Element | null | undefined): string => (el?.textContent ?? "").slice(0, RAW_TEXT_CHARS);

function samplePane(view: MarkdownView, side: Side | null): PaneSample {
	const leafEl = view.containerEl;
	const mode = view.getMode();
	const sample: PaneSample = {
		path: view.file?.path ?? "",
		side,
		mode,
		role: leafEl.getAttribute(ATTR.role),
		facing: leafEl.hasClass(CLS.facing),
		stacked: leafEl.hasClass(CLS.stacked),
		visible: leafEl.isShown(),
		scrollLine: null,
		scrollTop: null,
		scrollHeight: null,
		clientHeight: null,
		units: [],
		untagged: [],
		sections: null,
		current: [],
		partner: [],
		hover: [],
		unitCurrent: [],
		unitPartner: [],
	};
	if (mode !== "preview") return sample;

	const preview = view.previewMode;
	const root = preview.containerEl;
	const scroller = root.querySelector<HTMLElement>(".markdown-preview-view") ?? root;
	const scroll = preview.getScroll();
	sample.scrollLine = Number.isFinite(scroll) ? scroll : null;
	sample.scrollTop = Math.round(scroller.scrollTop);
	sample.scrollHeight = scroller.scrollHeight;
	sample.clientHeight = scroller.clientHeight;

	for (const el of Array.from(root.querySelectorAll(`[${ATTR.unit}]`))) {
		sample.units.push({
			key: el.getAttribute(ATTR.unit) ?? "",
			tag: el.tagName,
			fit: el.getAttribute(ATTR.fit),
			spans: el.querySelectorAll(`[${ATTR.link}]`).length,
			text: rawText(el),
		});
	}
	sample.untagged = Array.from(root.querySelectorAll(".markdown-preview-section > div"))
		.filter((div) => !div.querySelector(`[${ATTR.unit}]`) && !div.hasAttribute(ATTR.unit) && !div.hasAttribute(ATTR.menardSection) && (div.textContent ?? "").trim() !== "")
		.map((div) => rawText(div));

	const links = (cls: string): string[] => Array.from(root.querySelectorAll(`.${cls}[${ATTR.link}]`)).map((el) => el.getAttribute(ATTR.link) ?? "");
	const units = (cls: string): string[] => Array.from(root.querySelectorAll(`.${cls}[${ATTR.unit}]`)).map((el) => el.getAttribute(ATTR.unit) ?? "");
	sample.current = links(CLS.current);
	sample.partner = links(CLS.partner);
	sample.hover = links(CLS.hover);
	sample.unitCurrent = units(CLS.unitCurrent);
	sample.unitPartner = units(CLS.unitPartner);
	sample.sections = rendererSections(preview);
	return sample;
}

/** Shape of a reading-view renderer section; private Obsidian API, so every field is checked. */
interface RawSection {
	lineStart?: unknown;
	lineEnd?: unknown;
	start?: unknown;
	end?: unknown;
	height?: unknown;
	rendered?: unknown;
	el?: unknown;
}

/** Obsidian's renderer section list (private API, spike S1), or null when absent. */
export function rendererSections(preview: unknown): SectionSample[] | null {
	const renderer = (preview as { renderer?: { sections?: unknown } }).renderer;
	const sections = renderer?.sections;
	if (!Array.isArray(sections)) return null;
	return sections.map((entry: RawSection): SectionSample => {
		const el = entry.el instanceof HTMLElement ? entry.el : null;
		const unitEl = el ? (el.hasAttribute(ATTR.unit) ? el : el.querySelector(`[${ATTR.unit}]`)) : null;
		return {
			lineStart: firstNumber(entry.lineStart, entry.start),
			lineEnd: firstNumber(entry.lineEnd, entry.end),
			height: typeof entry.height === "number" ? entry.height : null,
			rendered: entry.rendered === true,
			menardLine: el?.hasAttribute(ATTR.menardSection) ?? false,
			unit: unitEl?.getAttribute(ATTR.unit) ?? null,
			text: rawText(el),
		};
	});
}

/** The first candidate that is a number; -1 when the private field names don't match this Obsidian version. */
function firstNumber(...candidates: unknown[]): number {
	for (const value of candidates) if (typeof value === "number") return value;
	return -1;
}
