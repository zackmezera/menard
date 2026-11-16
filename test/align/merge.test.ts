/**
 * Merged units (ADR 0010): the key-group grammar, the pair model, a block's
 * share of a merged side, and the matcher's merge moves and pairer.
 */
import { describe, expect, it } from "vitest";
import { lineKey, parseMenardLine, serializeMenardLine } from "../../src/align/map";
import { isDiagonal, matchSections, matchUnits, type MatchItem } from "../../src/align/match";
import { blockShare, fitUnitSide } from "../../src/align/merge";
import { buildPairModel, unitBlocks } from "../../src/align/model";
import { summarizeModel } from "../../src/diagnose/report";
import { parseNote } from "../../src/text/blocks";
import type { MenardLine, PairModel } from "../../src/types";
import { sigText } from "./helpers";

const OPTIONS = { textStartHeading: "", skipHeadings: [] };

describe("key groups in Menard lines", () => {
	it("parses and serializes a key group on maps and markers", () => {
		const map = `%%menard:1 p3+p4 ${sigText("Uno dos tres")}/${sigText("One two three")} -/2.abcd%%`;
		const parsed = parseMenardLine(map) as Extract<MenardLine, { kind: "map" }>;
		expect(parsed.key).toBe("p3");
		expect(parsed.group).toEqual(["p3", "p4"]);
		expect(serializeMenardLine(parsed)).toBe(map);
		expect(parseMenardLine("%%menard:1 p3+p12+intro-2 align%%")).toEqual({ kind: "marker", key: "p3", group: ["p3", "p12", "intro-2"], task: "align" });
		expect(lineKey({ key: "p3", group: ["p3", "p4"] })).toBe("p3+p4");
	});

	it("reads a line without a group exactly as before, with no group property", () => {
		const old = `%%menard:1 p1 ${sigText("Uno dos")}/${sigText("One two")}?%%`;
		const parsed = parseMenardLine(old);
		expect(parsed).not.toHaveProperty("group");
		expect(serializeMenardLine(parsed as MenardLine)).toBe(old);
	});

	it("rejects malformed groups", () => {
		expect(parseMenardLine("%%menard:1 p3+p3 align%%")).toEqual({ error: 'key group "p3+p3" names a block id twice' });
		expect(parseMenardLine("%%menard:1 fn:1+p3 align%%")).toHaveProperty("error");
		expect(parseMenardLine("%%menard:1 p3+ align%%")).toHaveProperty("error");
		expect(() => serializeMenardLine({ kind: "marker", key: "p4", group: ["p3", "p4"], task: "align" })).toThrow(RangeError);
	});
});

// Spanish p2 and p3 become one English paragraph (2-1); Spanish p5 becomes two (1-2).
const SOURCE = [
	"Uno dos tres. Cuatro cinco. ^p1",
	"Seis siete ocho. ^p2",
	"Nueve diez. ^p3",
	"Once doce. ^p4",
	"Trece catorce. Quince dieciséis. ^p5",
	"",
].join("\n\n");

/** The 2-1 map: its second link crosses the paragraph boundary ("ocho. Nueve diez"). */
const MERGED_MAP = `%%menard:1 p2+p3 ${sigText("Seis siete")}/${sigText("Six seven")} ${sigText("ocho Nueve diez")}/${sigText("eight nine ten")}%%`;
const SPLIT_MAP = `%%menard:1 p5+p9 ${sigText("Trece catorce")}/${sigText("Thirteen fourteen")} ${sigText("Quince dieciséis")}/${sigText("Fifteen sixteen")}%%`;
const TARGET = [
	"One two three. Four five. ^p1",
	"Six seven eight nine ten. ^p2",
	MERGED_MAP,
	"Eleven twelve. ^p4",
	"Thirteen fourteen. ^p5",
	"Fifteen sixteen. ^p9",
	SPLIT_MAP,
	"",
].join("\n\n");

function model(source: string, target: string): PairModel {
	return buildPairModel({
		sourcePath: "s.md",
		targetPath: "t.md",
		languages: { source: "es", target: "en" },
		version: 1,
		source: parseNote(source, OPTIONS),
		target: parseNote(target, OPTIONS),
	});
}

describe("merged units in the pair model", () => {
	const m = model(SOURCE, TARGET);

	it("makes one unit of each key group, keyed by its first key, in source order", () => {
		expect(m.problems).toEqual([]);
		expect(m.units.map((u) => u.key)).toEqual(["p1", "p2", "p4", "p5"]);
		const merged = m.unit("p2");
		expect(merged?.group?.keys).toEqual(["p2", "p3"]);
		expect(unitBlocks(merged!, "source").map((b) => b.id)).toEqual(["p2", "p3"]);
		expect(unitBlocks(merged!, "target").map((b) => b.id)).toEqual(["p2"]);
		expect(m.unit("p3")).toBe(merged);
		const split = m.unit("p9");
		expect(split?.key).toBe("p5");
		expect(unitBlocks(split!, "target").map((b) => b.id)).toEqual(["p5", "p9"]);
	});

	it("answers unitAtLine for every block of a merged unit, and spans its anchors over them", () => {
		const p3 = m.unit("p3")!.group!.source[1]!;
		expect(m.unitAtLine("source", p3.lines.start)?.key).toBe("p2");
		const p9 = m.unit("p5")!.group!.target[1]!;
		expect(m.unitAtLine("target", p9.lines.start)?.key).toBe("p5");
		const anchor = m.anchors().find((a) => a.key === "p2")!;
		expect(anchor.source).toEqual({ start: 2, end: p3.lines.end });
		expect(m.anchors().find((a) => a.key === "p5")!.target.end).toBe(p9.lines.end);
	});

	it("gives a merged unit one stop per link and fits each side across its blocks", () => {
		expect(m.stops().filter((s) => s.unit === "p2")).toEqual([
			{ unit: "p2", link: 1 },
			{ unit: "p2", link: 2 },
		]);
		expect(fitUnitSide(m.unit("p2")!, "source")?.status).toBe("exact");
		expect(fitUnitSide(m.unit("p5")!, "target")?.status).toBe("exact");
	});

	it("cuts a link that crosses the paragraph boundary into a share in each block", () => {
		const unit = m.unit("p2")!;
		const [p2, p3] = unit.group!.source;
		expect(blockShare(unit, "source", p2!)?.stored.map((s) => s?.count ?? null)).toEqual([2, 1]);
		expect(blockShare(unit, "source", p3!)?.stored.map((s) => s?.count ?? null)).toEqual([null, 2]);
		expect(blockShare(unit, "target", unit.group!.target[0]!)).toBeNull();
	});

	it("reports groups that cannot form, and a plain line for a grouped key", () => {
		const target = [
			TARGET,
			"%%menard:1 p3 align%%",
			"%%menard:1 p4+p77 align%%",
			"%%menard:1 p2+p4 align%%",
			"",
		].join("\n\n");
		const problems = model(SOURCE, target).problems.map((p) => p.error);
		expect(problems).toEqual([
			'"p3" belongs to the merged unit "p2"; this line is ignored',
			'merged unit "p4+p77" names "p77", which is in neither note',
			'"p2" already belongs to the merged unit "p2"; "p2+p4" is ignored',
		]);
	});

	it("lists merged units in the problem report without counting their members as one-sided", () => {
		const summary = summarizeModel(m, false);
		expect(summary.merged).toEqual(["p2+p3", "p5+p9"]);
		expect(summary.sourceOnly).toEqual([]);
		expect(summary.targetOnly).toEqual([]);
		expect(summary.statuses.source).toEqual({ exact: 2, repaired: 0, degraded: 0 });
	});

	it("leaves the unit unmerged when the group line is gone", () => {
		const plain = model(SOURCE, TARGET.replace(MERGED_MAP, ""));
		expect(plain.unit("p2")?.group).toBeUndefined();
		expect(plain.unit("p3")?.target).toBeNull();
	});
});

function item(kind: MatchItem["kind"], words: number, anchors: readonly string[] = []): MatchItem {
	return { kind, section: 0, words, anchors };
}

describe("matcher merges", () => {
	it("merges two source paragraphs that one translation paragraph renders (2-1)", () => {
		const source = [item("paragraph", 60), item("paragraph", 50), item("paragraph", 50), item("paragraph", 60)];
		const target = [item("paragraph", 66), item("paragraph", 112), item("paragraph", 64)];
		expect(matchUnits(source, target).pairs.map((p) => [p.source, p.target])).toEqual([
			[[0], [0]],
			[[1, 2], [1]],
			[[3], [2]],
		]);
	});

	it("splits one source paragraph rendered as two (1-2)", () => {
		const source = [item("paragraph", 60), item("paragraph", 110), item("paragraph", 60)];
		const target = [item("paragraph", 66), item("paragraph", 55), item("paragraph", 60), item("paragraph", 64)];
		expect(matchUnits(source, target).pairs.map((p) => [p.source, p.target])).toEqual([
			[[0], [0]],
			[[1], [1, 2]],
			[[2], [3]],
		]);
	});

	it("never merges a list or units of different kinds", () => {
		const source = [item("paragraph", 50), item("list", 50)];
		const target = [item("paragraph", 100)];
		expect(matchUnits(source, target).pairs.every((p) => p.source.length === 1)).toBe(true);
	});

	it("takes a section's pairs from the pairer, leaving units it omits unpaired", () => {
		const source = [item("paragraph", 60), item("paragraph", 50), item("paragraph", 50)];
		const target = [item("paragraph", 66), item("paragraph", 112)];
		const sections = matchSections(source, target);
		expect(sections).toEqual([{ source: [0, 1, 2], target: [0, 1] }]);
		expect(isDiagonal(source, target, sections[0]!.source, sections[0]!.target)).toBe(false);
		const asked: number[][][] = [];
		const result = matchUnits(source, target, (src, tgt) => {
			asked.push([[...src], [...tgt]]);
			return [{ source: [0], target: [1] }];
		});
		expect(asked).toEqual([[[0, 1, 2], [0, 1]]]);
		expect(result).toEqual({ pairs: [{ source: [0], target: [1], doubtful: false }], sourceOnly: [1, 2], targetOnly: [0] });
		expect(matchUnits(source, target, () => null)).toEqual(matchUnits(source, target));
	});
});
