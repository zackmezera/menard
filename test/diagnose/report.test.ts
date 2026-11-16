import { describe, expect, it } from "vitest";
import { buildPairModel } from "../../src/align/model";
import {
	ABSURD_SECTION_HEIGHT,
	basename,
	buildReport,
	redactSettings,
	renderReport,
	reportFileName,
	reportSections,
	snippet,
	summarizeModel,
} from "../../src/diagnose/report";
import type { PaneSample, ReportInput, SectionSample } from "../../src/diagnose/report";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { parseNote } from "../../src/text/blocks";
import type { PairModel } from "../../src/types";
import { sigText } from "../align/helpers";

const OPTIONS = { textStartHeading: "", skipHeadings: [] };

const SOURCE = [
	"Primera frase secreta del texto. Segunda frase también secreta. ^p1", // 0
	"",
	"Tercera frase sin cambios. ^p2", // 2
	"",
	"Solo existe en el original. ^p3", // 4
	"",
].join("\n");

const TARGET = [
	"First secret sentence of the text. Second sentence also secret. ^p1", // 0
	"",
	`%%menard:1 p1 ${sigText("Primera frase secreta del texto.")}/${sigText("First secret sentence of the text.")} ${sigText("Segunda frase también secreta.")}/${sigText("Second sentence also secret.")}%%`, // 2
	"",
	"Third sentence, now rewritten entirely by hand. ^p2", // 4
	"",
	`%%menard:1 p2 ${sigText("Tercera frase sin cambios.")}/${sigText("Third sentence unchanged.")}%%`, // 6
	"",
	"%%menard:1 p7 bogus line%%", // 8
	"",
].join("\n");

function model(): PairModel {
	return buildPairModel({
		sourcePath: "Texts/@x.md",
		targetPath: "Texts/@x (EN).md",
		languages: { source: "es", target: "en" },
		version: 3,
		source: parseNote(SOURCE, OPTIONS),
		target: parseNote(TARGET, OPTIONS),
	});
}

const section = (over: Partial<SectionSample>): SectionSample => ({
	lineStart: 0,
	lineEnd: 0,
	height: 20,
	rendered: true,
	menardLine: false,
	unit: null,
	text: "",
	...over,
});

function pane(over: Partial<PaneSample> = {}): PaneSample {
	return {
		path: "Texts/@x (EN).md",
		side: "target",
		mode: "preview",
		role: "target",
		facing: true,
		stacked: false,
		visible: true,
		scrollLine: 0,
		scrollTop: 0,
		scrollHeight: 1000,
		clientHeight: 500,
		units: [
			{ key: "p1", tag: "P", fit: "exact", spans: 2, text: "First secret sentence of the text. Second sentence also secret." },
			{ key: "p2", tag: "P", fit: "approximate", spans: 0, text: "Third sentence, now rewritten" },
		],
		untagged: ["A secret untagged paragraph"],
		sections: [
			section({ lineStart: 0, lineEnd: 0, unit: "p1", text: "First secret sentence" }),
			section({ lineStart: 2, lineEnd: 2, height: -14, menardLine: true }),
			section({ lineStart: 4, lineEnd: 4, height: 14, text: "Third sentence" }),
			section({ lineStart: 6, lineEnd: 6, height: ABSURD_SECTION_HEIGHT + 1, menardLine: true }),
		],
		current: ["p1.1", "p1.1"],
		partner: [],
		hover: [],
		unitCurrent: [],
		unitPartner: [],
		...over,
	};
}

function input(over: Partial<ReportInput> = {}): ReportInput {
	return {
		generatedAt: "2026-10-04T12:00:00.000Z",
		env: { pluginVersion: "0.0.1", obsidianVersion: "1.13.0", platform: "macOS, desktop" },
		settings: { ...DEFAULT_SETTINGS, claudePath: "/Users/someone/.local/bin/claude", extraInstructions: "Keep it formal." },
		activePath: "Texts/@x (EN).md",
		pair: { source: "Texts/@x.md", target: "Texts/@x (EN).md" },
		model: model(),
		panes: [pane()],
		session: { active: true, currentUnit: "p1" },
		snippets: false,
		...over,
	};
}

describe("snippet and redaction", () => {
	it("drops text unless snippets are on, and cuts it to 40 characters", () => {
		expect(snippet("anything", false)).toBeUndefined();
		expect(snippet("  short\n text ", true)).toBe("short text");
		const cut = snippet("x".repeat(100), true);
		expect(cut).toBe(`${"x".repeat(40)}…`);
	});

	it("keeps only the basename of claudePath and hides free text", () => {
		const redacted = redactSettings({ ...DEFAULT_SETTINGS, claudePath: "C:\\Users\\me\\bin\\claude.exe", extraInstructions: "secret", newNoteProperties: "a: 1\nb: 2\n" });
		expect(redacted.claudePath).toBe("claude.exe");
		expect(redacted.extraInstructions).toBe("<6 chars>");
		expect(redacted.newNoteProperties).toBe("<2 lines>");
		expect(redactSettings(DEFAULT_SETTINGS).claudePath).toBe("");
		expect(basename("/a/b/")).toBe("b");
	});
});

describe("summarizeModel", () => {
	it("counts units, pairing, map fits and problems", () => {
		const summary = summarizeModel(model(), false);
		expect(summary.units).toBe(3);
		expect(summary.paired).toBe(2);
		expect(summary.sourceOnly).toEqual(["p3"]);
		expect(summary.withMap).toBe(2);
		expect(summary.links).toBe(3);
		expect(summary.fits.source).toEqual({ exact: 3, edited: 0, approximate: 0, lost: 0, empty: 0 });
		expect(summary.fits.target.exact).toBe(2);
		expect(summary.fits.target.edited).toBe(1);
		expect(summary.statuses.target).toEqual({ exact: 1, repaired: 1, degraded: 0 });
		expect(summary.repaired).toEqual(["p2"]);
		expect(summary.degraded).toEqual([]);
		expect(summary.problems).toHaveLength(1);
		expect(summary.problems[0]?.line).toBe(8);
		expect(summary.problems[0]?.raw).toBeUndefined();
		expect(summarizeModel(model(), true).problems[0]?.raw).toContain("%%menard:1 p7");
	});
});

describe("reportSections", () => {
	it("flags negative, absurd and missing heights, and rendered units left untagged", () => {
		const report = reportSections(
			[...(pane().sections ?? []), section({ lineStart: 9, lineEnd: 9, height: Number.NaN })],
			model(),
			"target",
			false,
		);
		expect(report.count).toBe(5);
		expect(report.negative).toEqual([[2, 2]]);
		expect(report.absurd).toEqual([[6, 6]]);
		expect(report.missingHeight).toEqual([[9, 9]]);
		expect(report.untaggedUnits).toEqual([{ lines: [4, 4], key: "p2" }]);
		expect(report.menardLines).toBe(2);
		expect(report.rows.every((row) => row.text === undefined)).toBe(true);
	});
});

describe("buildReport", () => {
	it("contains no note text by default", () => {
		const text = renderReport(buildReport(input()));
		for (const secret of ["secret", "Third sentence", "someone", "Keep it formal"]) expect(text).not.toContain(secret);
		expect(text).toContain("Contains no note text");
		expect(text).toContain('"claudePath": "claude"');
	});

	it("adds 40-character snippets only when asked", () => {
		const report = buildReport(input({ snippets: true }));
		expect(report.panes[0]?.units[0]?.text).toBe("First secret sentence of the text. Secon…");
		expect(report.panes[0]?.untagged.text).toEqual(["A secret untagged paragraph"]);
		expect(renderReport(report)).toContain("Includes text snippets");
	});

	it("summarizes pane tagging and session state, and lists findings", () => {
		const report = buildReport(input());
		const p = report.panes[0];
		expect(p?.taggedUnits).toBe(2);
		expect(p?.fitAttrs).toEqual({ exact: 1, approximate: 1 });
		expect(p?.spans).toBe(2);
		expect(p?.unitsWithoutSpans).toEqual(["p2"]);
		expect(p?.cursor.current).toEqual(["p1.1"]);
		expect(report.session).toEqual({ active: true, currentUnit: "p1", facingPanes: 1, stackedPanes: 0 });
		const findings = report.findings.join("\n");
		expect(findings).toContain("1 malformed or orphaned Menard line");
		expect(findings).toContain("1 source unit without a translation");
		expect(findings).toContain("negative height (lines 2–2)");
		expect(findings).toContain(`taller than ${ABSURD_SECTION_HEIGHT}px`);
		expect(findings).toContain("not tagged (keys p2)");
	});

	it("reports a note outside any pair, and panes in editing mode", () => {
		const report = buildReport(input({ pair: null, model: null, panes: [pane({ side: null, mode: "source", sections: null, units: [] })] }));
		expect(report.model).toBeNull();
		expect(report.findings[0]).toMatch(/not part of a pair/);
		expect(report.findings.join("\n")).toContain("editing mode");
	});
});

describe("reportFileName", () => {
	it("dates the name and numbers it when taken", () => {
		const date = new Date(2026, 9, 4);
		expect(reportFileName(date, () => false)).toBe("menard-report-2026-10-04.md");
		const taken = new Set(["menard-report-2026-10-04.md", "menard-report-2026-10-04-2.md"]);
		expect(reportFileName(date, (name) => taken.has(name))).toBe("menard-report-2026-10-04-3.md");
	});
});
