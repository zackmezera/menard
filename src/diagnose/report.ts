/**
 * The "Report a problem" diagnostic: turns raw samples of the plugin, the
 * pair model and the open reading panes into a redacted report. Pure; the
 * DOM and workspace side is in collect.ts. Never writes, never scrolls.
 */
import { fitUnitSide } from "../align/merge";
import { unitBlocks } from "../align/model";
import type { LinkFit, MenardSettings, PairModel, ReconciledSide, Side, UnitKind } from "../types";

/** Longest text snippet a report may carry, and only when snippets are turned on. */
export const SNIPPET_CHARS = 40;
/** A section taller than this (px) is treated as a renderer miscalculation. */
export const ABSURD_SECTION_HEIGHT = 100_000;
/** Most sections listed per pane; the rest are only counted. */
export const MAX_SECTIONS = 2000;

export interface EnvSample {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
}

/** One entry of Obsidian's reading-view renderer `sections` list, as read from the DOM. */
export interface SectionSample {
	/** 0-based first and last line, as Obsidian reports them. */
	lineStart: number;
	lineEnd: number;
	/** Height Obsidian holds for the section, in px; null when it reported none. */
	height: number | null;
	rendered: boolean;
	/** The section holds only a Menard line (`data-menard-line`). */
	menardLine: boolean;
	/** `data-menard-unit` of the unit element inside the section, if tagged. */
	unit: string | null;
	/** Raw text; the report keeps it only as a snippet, and only when snippets are on. */
	text: string;
}

/** A tagged unit element found in a pane's DOM. */
export interface UnitSample {
	key: string;
	tag: string;
	fit: string | null;
	spans: number;
	text: string;
}

export interface PaneSample {
	path: string;
	/** Which note of the pair the pane shows, or null outside the pair. */
	side: Side | null;
	/** Markdown view mode: "preview" for reading view, "source" for editing. */
	mode: string;
	/** `data-menard-role` on the leaf container. */
	role: string | null;
	facing: boolean;
	stacked: boolean;
	visible: boolean;
	/** Reading-view scroll position in lines (`getScroll()`), when available. */
	scrollLine: number | null;
	scrollTop: number | null;
	scrollHeight: number | null;
	clientHeight: number | null;
	units: UnitSample[];
	/** Text of rendered sections that hold neither a unit nor a Menard line. */
	untagged: string[];
	/** Renderer sections, or null when the renderer could not be read. */
	sections: SectionSample[] | null;
	/** `data-menard-link` values carrying the current, partner and hover classes. */
	current: string[];
	partner: string[];
	hover: string[];
	/** Unit keys highlighted as a whole. */
	unitCurrent: string[];
	unitPartner: string[];
}

export interface SessionSample {
	active: boolean;
	currentUnit: string | null;
}

export interface ReportInput {
	generatedAt: string;
	env: EnvSample;
	settings: MenardSettings;
	activePath: string | null;
	pair: { source: string; target: string } | null;
	model: PairModel | null;
	panes: readonly PaneSample[];
	session: SessionSample;
	/** Keep up to SNIPPET_CHARS of note text per item. Off by default. */
	snippets: boolean;
}

type FitCounts = Record<LinkFit, number>;
type StatusCounts = Record<ReconciledSide["status"], number>;

export interface ModelSummary {
	sourcePath: string;
	targetPath: string;
	languages: { source: string; target: string };
	version: number;
	units: number;
	byKind: Partial<Record<UnitKind, number>>;
	paired: number;
	/** Paired headings that read the same in both notes of a pair in two languages: likely left untranslated (#35). */
	untranslatedHeadings: string[];
	/** Merged units (ADR 0010), as their key groups: "p3+p4". */
	merged: string[];
	sourceOnly: string[];
	targetOnly: string[];
	pending: { key: string; task: string }[];
	sentenceUnits: number;
	withMap: number;
	withoutMap: string[];
	links: number;
	fits: { source: FitCounts; target: FitCounts };
	statuses: { source: StatusCounts; target: StatusCounts };
	degraded: string[];
	repaired: string[];
	stops: number;
	anchors: number;
	problems: { line: number; error: string | null; raw?: string }[];
}

export interface SectionReport {
	count: number;
	listed: number;
	rendered: number;
	menardLines: number;
	totalHeight: number;
	/** Every listed section: [lineStart, lineEnd, height, flags]. */
	rows: { lines: [number, number]; h: number | null; rendered: boolean; menardLine: boolean; unit: string | null; text?: string }[];
	negative: [number, number][];
	absurd: [number, number][];
	missingHeight: [number, number][];
	/** Rendered sections whose lines hold a model unit, without a tagged unit element. */
	untaggedUnits: { lines: [number, number]; key: string }[];
}

export interface PaneReport {
	path: string;
	side: Side | null;
	mode: string;
	role: string | null;
	facing: boolean;
	stacked: boolean;
	visible: boolean;
	scroll: { line: number | null; top: number | null; height: number | null; client: number | null };
	taggedUnits: number;
	fitAttrs: Record<string, number>;
	spans: number;
	unitsWithoutSpans: string[];
	units: { key: string; tag: string; fit: string | null; spans: number; text?: string }[];
	untagged: { count: number; text?: string[] };
	sections: SectionReport | null;
	cursor: { current: string[]; partner: string[]; hover: string[]; unitCurrent: string[]; unitPartner: string[] };
}

export interface DiagnosticReport {
	generatedAt: string;
	env: EnvSample;
	settings: Record<string, unknown>;
	activePath: string | null;
	pair: { source: string; target: string } | null;
	model: ModelSummary | null;
	session: SessionSample & { facingPanes: number; stackedPanes: number };
	panes: PaneReport[];
	snippets: boolean;
	/** Plain-language list of what looks wrong. */
	findings: string[];
}

/** The text cut to SNIPPET_CHARS when snippets are on; undefined otherwise. */
export function snippet(text: string, include: boolean): string | undefined {
	if (!include) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/** The last path segment of a file path, for either separator. */
export function basename(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? "";
}

/**
 * Settings as the report shows them: `claudePath` cut to its basename (it can
 * hold a user name), and free-text instructions and note properties reduced to
 * their length.
 */
export function redactSettings(settings: MenardSettings): Record<string, unknown> {
	const out: Record<string, unknown> = { ...settings };
	out.claudePath = settings.claudePath.trim() === "" ? "" : basename(settings.claudePath.trim());
	out.extraInstructions = `<${settings.extraInstructions.length} chars>`;
	out.newNoteProperties = `<${settings.newNoteProperties.split("\n").filter((line) => line.trim() !== "").length} lines>`;
	return out;
}

const emptyFits = (): FitCounts => ({ exact: 0, edited: 0, approximate: 0, lost: 0, empty: 0 });
const emptyStatuses = (): StatusCounts => ({ exact: 0, repaired: 0, degraded: 0 });
const isSentenceKind = (kind: UnitKind): boolean => kind === "paragraph" || kind === "quote" || kind === "callout";


/** Unit, pairing, map-fit and problem counts for a pair model. Keys and line numbers only; text only as snippets. */
const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function summarizeModel(model: PairModel, snippets: boolean): ModelSummary {
	const summary: ModelSummary = {
		sourcePath: model.sourcePath,
		targetPath: model.targetPath,
		languages: { ...model.languages },
		version: model.version,
		units: model.units.length,
		byKind: {},
		paired: 0,
		untranslatedHeadings: [],
		merged: [],
		sourceOnly: [],
		targetOnly: [],
		pending: [],
		sentenceUnits: 0,
		withMap: 0,
		withoutMap: [],
		links: 0,
		fits: { source: emptyFits(), target: emptyFits() },
		statuses: { source: emptyStatuses(), target: emptyStatuses() },
		degraded: [],
		repaired: [],
		stops: model.stops().length,
		anchors: model.anchors().length,
		problems: model.problems.map((problem) => {
			const raw = snippet(problem.raw, snippets);
			return { line: problem.line, error: problem.error ?? null, ...(raw === undefined ? {} : { raw }) };
		}),
	};
	const primary = (lang: string): string => lang.toLowerCase().split(/[-_]/)[0] ?? "";
	const differ = primary(model.languages.source) !== primary(model.languages.target);
	for (const unit of model.units) {
		summary.byKind[unit.kind] = (summary.byKind[unit.kind] ?? 0) + 1;
		if (unit.pending !== null) summary.pending.push({ key: unit.key, task: unit.pending });
		if (unit.group) summary.merged.push(unit.group.keys.join("+"));
		if (unit.kind === "heading" && unit.source && unit.target && differ && sameText(unit.source.body, unit.target.body)) summary.untranslatedHeadings.push(unit.key);
		if (unit.source && unit.target) summary.paired++;
		else if (unit.source) summary.sourceOnly.push(unit.key);
		else if (unit.target) summary.targetOnly.push(unit.key);
		if (!isSentenceKind(unit.kind) || !unit.source || !unit.target) continue;
		summary.sentenceUnits++;
		if (!unit.map) {
			if (unit.pending === null) summary.withoutMap.push(unit.key);
			continue;
		}
		summary.withMap++;
		summary.links += unit.map.links.length;
		let worst: ReconciledSide["status"] = "exact";
		for (const side of ["source", "target"] as const) {
			const fitted = fitUnitSide(unit, side);
			if (!fitted) continue;
			summary.statuses[side][fitted.status]++;
			for (const fit of fitted.fits) summary.fits[side][fit]++;
			if (fitted.status === "degraded") worst = "degraded";
			else if (fitted.status === "repaired" && worst === "exact") worst = "repaired";
		}
		if (worst === "degraded") summary.degraded.push(unit.key);
		else if (worst === "repaired") summary.repaired.push(unit.key);
	}
	return summary;
}

/** Lists a pane's renderer sections and flags heights Obsidian should never hold. */
export function reportSections(sections: readonly SectionSample[], model: PairModel | null, side: Side | null, snippets: boolean): SectionReport {
	const lines = (s: SectionSample): [number, number] => [s.lineStart, s.lineEnd];
	const report: SectionReport = {
		count: sections.length,
		listed: Math.min(sections.length, MAX_SECTIONS),
		rendered: 0,
		menardLines: 0,
		totalHeight: 0,
		rows: [],
		negative: [],
		absurd: [],
		missingHeight: [],
		untaggedUnits: [],
	};
	sections.forEach((section, index) => {
		if (section.rendered) report.rendered++;
		if (section.menardLine) report.menardLines++;
		const h = section.height;
		if (h === null || !Number.isFinite(h)) report.missingHeight.push(lines(section));
		else {
			report.totalHeight += h;
			if (h < 0) report.negative.push(lines(section));
			else if (h > ABSURD_SECTION_HEIGHT) report.absurd.push(lines(section));
		}
		if (model && side && section.rendered && !section.menardLine && section.unit === null) {
			const unit = model.unitAtLine(side, section.lineStart);
			const starts = unit ? unitBlocks(unit, side).some((block) => block.lines.start === section.lineStart) : false;
			if (unit && starts && unit.kind !== "heading") {
				report.untaggedUnits.push({ lines: lines(section), key: unit.key });
			}
		}
		if (index < MAX_SECTIONS) {
			const text = snippet(section.text, snippets);
			report.rows.push({
				lines: lines(section),
				h: h === null || !Number.isFinite(h) ? null : Math.round(h),
				rendered: section.rendered,
				menardLine: section.menardLine,
				unit: section.unit,
				...(text === undefined ? {} : { text }),
			});
		}
	});
	report.totalHeight = Math.round(report.totalHeight);
	return report;
}

function reportPane(pane: PaneSample, model: PairModel | null, snippets: boolean): PaneReport {
	const fitAttrs: Record<string, number> = {};
	for (const unit of pane.units) {
		const fit = unit.fit ?? "none";
		fitAttrs[fit] = (fitAttrs[fit] ?? 0) + 1;
	}
	const untaggedText = snippets ? pane.untagged.map((text) => snippet(text, true) ?? "") : undefined;
	const unique = (values: readonly string[]): string[] => [...new Set(values)];
	return {
		path: pane.path,
		side: pane.side,
		mode: pane.mode,
		role: pane.role,
		facing: pane.facing,
		stacked: pane.stacked,
		visible: pane.visible,
		scroll: { line: pane.scrollLine, top: pane.scrollTop, height: pane.scrollHeight, client: pane.clientHeight },
		taggedUnits: pane.units.length,
		fitAttrs,
		spans: pane.units.reduce((sum, unit) => sum + unit.spans, 0),
		unitsWithoutSpans: pane.units.filter((unit) => unit.spans === 0 && (model?.unit(unit.key)?.map ?? null) !== null).map((unit) => unit.key),
		units: pane.units.map((unit) => {
			const text = snippet(unit.text, snippets);
			return { key: unit.key, tag: unit.tag, fit: unit.fit, spans: unit.spans, ...(text === undefined ? {} : { text }) };
		}),
		untagged: { count: pane.untagged.length, ...(untaggedText === undefined ? {} : { text: untaggedText }) },
		sections: pane.sections ? reportSections(pane.sections, model, pane.side, snippets) : null,
		cursor: {
			current: unique(pane.current),
			partner: unique(pane.partner),
			hover: unique(pane.hover),
			unitCurrent: unique(pane.unitCurrent),
			unitPartner: unique(pane.unitPartner),
		},
	};
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const ranges = (list: readonly [number, number][]): string =>
	list
		.slice(0, 5)
		.map(([a, b]) => `${a}–${b}`)
		.join(", ") + (list.length > 5 ? ", …" : "");

function findings(report: Omit<DiagnosticReport, "findings">): string[] {
	const out: string[] = [];
	if (report.activePath === null) out.push("No note was active.");
	else if (report.pair === null) out.push("The active note is not part of a pair (both notes must link to each other in frontmatter).");
	const m = report.model;
	if (report.pair && !m) out.push("The pair model could not be built.");
	if (m) {
		if (m.problems.length > 0) out.push(`${plural(m.problems.length, "malformed or orphaned Menard line")} in the translation note.`);
		if (m.untranslatedHeadings.length > 0) {
			out.push(`${plural(m.untranslatedHeadings.length, "heading")} read the same in both notes, so may be untranslated (Translate note keeps the source headings when Claude's heading translation fails).`);
		}
		if (m.sourceOnly.length > 0) out.push(`${plural(m.sourceOnly.length, "source unit")} without a translation.`);
		if (m.targetOnly.length > 0) out.push(`${plural(m.targetOnly.length, "translation unit")} without a source.`);
		if (m.pending.length > 0) out.push(`${plural(m.pending.length, "pending marker")} (unfinished job).`);
		if (m.withoutMap.length > 0) out.push(`${plural(m.withoutMap.length, "paired sentence unit")} without a sentence map.`);
		if (m.degraded.length > 0) out.push(`${plural(m.degraded.length, "sentence map")} no longer fit the text (degraded).`);
		const lost = m.fits.source.lost + m.fits.target.lost;
		if (lost > 0) out.push(`${plural(lost, "link side")} lost.`);
	}
	for (const pane of report.panes) {
		const name = basename(pane.path);
		if (pane.mode !== "preview") {
			out.push(`${name} is open in editing mode; only reading view is tagged.`);
			continue;
		}
		const rows = pane.sections?.rows ?? [];
		if (rows.length > 0 && rows.every((row) => row.lines[0] === -1)) out.push(`Could not read section line numbers in ${name} (this Obsidian version names them differently); unit checks by line were skipped.`);
		if (pane.taggedUnits === 0 && m && m.units > 0) out.push(`${name}: no unit is tagged in the rendered reading view.`);
		if (pane.unitsWithoutSpans.length > 0) out.push(`${name}: ${plural(pane.unitsWithoutSpans.length, "unit")} with a map but no sentence spans.`);
		const s = pane.sections;
		if (!s) {
			out.push(`${name}: the reading-view renderer could not be read.`);
			continue;
		}
		if (s.negative.length > 0) out.push(`${name}: ${plural(s.negative.length, "section")} with a negative height (lines ${ranges(s.negative)}).`);
		if (s.absurd.length > 0) out.push(`${name}: ${plural(s.absurd.length, "section")} taller than ${ABSURD_SECTION_HEIGHT}px (lines ${ranges(s.absurd)}).`);
		if (s.untaggedUnits.length > 0) out.push(`${name}: ${plural(s.untaggedUnits.length, "rendered unit")} not tagged (keys ${s.untaggedUnits.slice(0, 5).map((u) => u.key).join(", ")}).`);
	}
	if (report.pair && report.panes.length === 0) out.push("Neither note of the pair is open.");
	return out;
}

/** Builds the full report. Text from the notes appears only as SNIPPET_CHARS snippets, and only when `input.snippets`. */
export function buildReport(input: ReportInput): DiagnosticReport {
	const panes = input.panes.map((pane) => reportPane(pane, input.model, input.snippets));
	const base = {
		generatedAt: input.generatedAt,
		env: input.env,
		settings: redactSettings(input.settings),
		activePath: input.activePath,
		pair: input.pair,
		model: input.model ? summarizeModel(input.model, input.snippets) : null,
		session: {
			...input.session,
			facingPanes: panes.filter((pane) => pane.facing).length,
			stackedPanes: panes.filter((pane) => pane.stacked).length,
		},
		panes,
		snippets: input.snippets,
	};
	return { ...base, findings: findings(base) };
}

/** The report as a Markdown note: findings first, then the full data as JSON. */
export function renderReport(report: DiagnosticReport): string {
	const lines = [
		`# Menard problem report`,
		"",
		`Generated ${report.generatedAt} · Menard ${report.env.pluginVersion} · Obsidian ${report.env.obsidianVersion} · ${report.env.platform}`,
		"",
		report.snippets
			? `Includes text snippets of up to ${SNIPPET_CHARS} characters per item.`
			: "Contains no note text: paths, unit keys, line numbers, counts and heights only.",
		"",
		"## Findings",
		"",
		...(report.findings.length > 0 ? report.findings.map((finding) => `- ${finding}`) : ["- Nothing looks wrong."]),
		"",
		"## Data",
		"",
		"```json",
		JSON.stringify(report, null, 1),
		"```",
		"",
	];
	return lines.join("\n");
}

/** `menard-report-YYYY-MM-DD.md`, numbered when that name is taken. */
export function reportFileName(date: Date, exists: (name: string) => boolean): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	const stem = `menard-report-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	if (!exists(`${stem}.md`)) return `${stem}.md`;
	for (let n = 2; ; n++) if (!exists(`${stem}-${n}.md`)) return `${stem}-${n}.md`;
}
