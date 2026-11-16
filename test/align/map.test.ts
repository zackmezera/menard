import { describe, expect, it } from "vitest";
import { linksFromRanges, parseMenardLine, serializeMenardLine, sideOf, validateLinks } from "../../src/align/map";
import { wordsOf } from "../../src/align/words";
import type { MapLink, MenardLine } from "../../src/types";
import { sigOf } from "./helpers";
import { ORMSBY_1, ORMSBY_2, ORMSBY_ADDITION, QUIJOTE_1, QUIJOTE_2 } from "./fixtures";

const DESIGN_VARIANTS = [
	"%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%",
	"%%menard:1 p1 33.myfp/46.6ton 33.7teg/36.xsyq%%",
	"%%menard:1 p1 66.j87o/61.abc0%%",
	"%%menard:1 p1 66.j87o/61.abc0?%%",
	"%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r -/7.e5eo%%",
	"%%menard:1 p2 translate%%",
	"%%menard:1 p3 align%%",
	"%%menard:1 fn:1 translate%%",
];

describe("parseMenardLine", () => {
	it("parses the 1→1, 1→1 map of DESIGN §4.3", () => {
		expect(parseMenardLine(DESIGN_VARIANTS[0] as string)).toEqual({
			kind: "map",
			key: "p1",
			links: [
				{ src: { count: 33, hash: "myfp" }, tgt: { count: 46, hash: "6ton" }, loose: false },
				{ src: { count: 33, hash: "7teg" }, tgt: { count: 35, hash: "ny2r" }, loose: false },
			],
		});
	});

	it("parses a loose fused link and a flagged translator's addition", () => {
		expect(parseMenardLine("%%menard:1 p1 66.j87o/61.abc0?%%")).toEqual({
			kind: "map",
			key: "p1",
			links: [{ src: { count: 66, hash: "j87o" }, tgt: { count: 61, hash: "abc0" }, loose: true }],
		});
		const addition = parseMenardLine(DESIGN_VARIANTS[4] as string);
		expect("links" in addition && addition.links[2]).toEqual({ src: null, tgt: { count: 7, hash: "e5eo" }, loose: false });
	});

	it("parses pending markers, including footnotes and user ids", () => {
		expect(parseMenardLine("%%menard:1 p2 translate%%")).toEqual({ kind: "marker", key: "p2", task: "translate" });
		expect(parseMenardLine("%%menard:1 p3 align%%")).toEqual({ kind: "marker", key: "p3", task: "align" });
		expect(parseMenardLine("%%menard:1 fn:1 translate%%")).toEqual({ kind: "marker", key: "fn:1", task: "translate" });
		expect(parseMenardLine("%%menard:1 fn:en_3 translate%%")).toEqual({ kind: "marker", key: "fn:en_3", task: "translate" });
		expect(parseMenardLine("%%menard:1 intro-1 align%%")).toEqual({ kind: "marker", key: "intro-1", task: "align" });
	});

	it("accepts the count bounds 1 and 9999", () => {
		expect(parseMenardLine("%%menard:1 p1 1.0000/9999.zzzz%%")).toMatchObject({ kind: "map" });
	});

	it.each([
		["text that is not Menard's", "%%p. 2%%", /not a Menard line/],
		["a missing closing", "%%menard:1 p1 translate", /unterminated/],
		["another version", "%%menard:2 p1 translate%%", /version "2"/],
		["a missing key", "%%menard:1 %%", /key/],
		["a key with a colon", "%%menard:1 h:1 translate%%", /invalid unit key "h:1"/],
		["a key with a caret", "%%menard:1 ^p1 translate%%", /invalid unit key/],
		["a missing body", "%%menard:1 p1%%", /missing body/],
		["a link with both sides empty", "%%menard:1 p1 -/-%%", /both sides are empty/],
		["a zero count", "%%menard:1 p1 0.abcd/3.abcd%%", /bad source side/],
		["a five-digit count", "%%menard:1 p1 10000.abcd/3.abcd%%", /bad source side/],
		["a leading-zero count", "%%menard:1 p1 03.abcd/3.abcd%%", /bad source side/],
		["an upper-case hash", "%%menard:1 p1 3.ABCD/3.abcd%%", /bad source side/],
		["a short hash", "%%menard:1 p1 3.abcd/3.abc%%", /bad target side/],
		["a missing slash", "%%menard:1 p1 3.abcd%%", /<source>\/<target>/],
		["two spaces", "%%menard:1 p1 3.abcd/3.abcd  3.abcd/3.abcd%%", /empty link/],
		["a trailing space", "%%menard:1 p1 3.abcd/3.abcd %%", /empty link/],
		["a marker with extra words", "%%menard:1 p1 translate now%%", /link 1 \("translate"\)/],
		["a percent sign inside", "%%menard:1 p1 3.ab%d/3.abcd%%", /'%'/],
		["text after the closing", "%%menard:1 p1 translate%% ^p1", /unterminated|'%'/],
	])("rejects %s", (_name, raw, message) => {
		const result = parseMenardLine(raw);
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toMatch(message);
	});
});

describe("serializeMenardLine", () => {
	it.each(DESIGN_VARIANTS)("round-trips %s", (raw) => {
		const parsed = parseMenardLine(raw) as MenardLine;
		expect(serializeMenardLine(parsed)).toBe(raw);
		expect(parseMenardLine(serializeMenardLine(parsed))).toEqual(parsed);
	});

	it("refuses to write an invalid map or key", () => {
		expect(() => serializeMenardLine({ kind: "map", key: "p1", links: [] })).toThrow(/at least one link/);
		expect(() => serializeMenardLine({ kind: "map", key: "p1", links: [{ src: null, tgt: null, loose: false }] })).toThrow(/both sides/);
		expect(() => serializeMenardLine({ kind: "marker", key: "p 1", task: "align" })).toThrow(/key/);
	});
});

describe("validateLinks", () => {
	it("accepts a well-formed map", () => {
		expect(validateLinks([{ src: { count: 3, hash: "a1b2" }, tgt: null, loose: false }])).toEqual([]);
	});

	it("reports every structural error with its link number", () => {
		const links: MapLink[] = [
			{ src: null, tgt: null, loose: false },
			{ src: { count: 0, hash: "abcd" }, tgt: { count: 2.5, hash: "abcd" }, loose: false },
			{ src: { count: 3, hash: "ABCD" }, tgt: { count: 3, hash: "abcde" }, loose: true },
		];
		expect(validateLinks(links)).toEqual([
			"link 1: both sides are empty",
			"link 2: source count 0 is not an integer from 1 to 9999",
			"link 2: target count 2.5 is not an integer from 1 to 9999",
			'link 3: source hash "ABCD" is not 4 lower-case base-36 characters',
			'link 3: target hash "abcde" is not 4 lower-case base-36 characters',
		]);
		expect(validateLinks([])).toEqual(["a sentence map needs at least one link"]);
	});
});

describe("linksFromRanges", () => {
	const source = `${QUIJOTE_1} ${QUIJOTE_2}`;
	const target = `${ORMSBY_1} ${ORMSBY_2} ${ORMSBY_ADDITION}`;
	const srcWords = wordsOf(source);
	const tgtWords = wordsOf(target);

	it("signs each side's range and leaves empty ranges null", () => {
		const links = linksFromRanges(
			{ words: srcWords, ranges: [{ start: 0, end: 33 }, { start: 33, end: 66 }, { start: 66, end: 66 }] },
			{ words: tgtWords, ranges: [{ start: 0, end: 46 }, { start: 46, end: 81 }, { start: 81, end: 88 }] },
			[false, false, true],
		);
		expect(serializeMenardLine({ kind: "map", key: "p1", links })).toBe("%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r -/7.e5eo?%%");
		expect(links[0]?.src).toEqual(sigOf(QUIJOTE_1));
	});

	it("never produces a link empty on both sides", () => {
		expect(() =>
			linksFromRanges({ words: srcWords, ranges: [{ start: 0, end: 0 }] }, { words: tgtWords, ranges: [{ start: 4, end: 4 }] }, [false]),
		).toThrow(/both sides/);
	});

	it("refuses ranges that skip, overlap or leave out words, so counts always sum to the word total", () => {
		const tgt = { words: tgtWords, ranges: [{ start: 0, end: 46 }, { start: 46, end: 88 }] };
		const make = (ranges: { start: number; end: number }[]) => () => linksFromRanges({ words: srcWords, ranges }, tgt, [false, false]);
		expect(make([{ start: 0, end: 30 }, { start: 33, end: 66 }])).toThrow(/source range 2 starts at word 33, expected 30/);
		expect(make([{ start: 0, end: 40 }, { start: 33, end: 66 }])).toThrow(/expected 40/);
		expect(make([{ start: 0, end: 33 }, { start: 33, end: 60 }])).toThrow(/source ranges cover 60 of 66 words/);
		expect(make([{ start: 33, end: 66 }, { start: 0, end: 33 }])).toThrow(RangeError);
		expect(make([{ start: 0, end: 66 }, { start: 5, end: 3 }])).toThrow(/ends before it starts/);
		expect(() =>
			linksFromRanges({ words: srcWords, ranges: [{ start: 0, end: 66 }] }, { words: tgtWords, ranges: [{ start: 0, end: 80 }] }, [false]),
		).toThrow(/target ranges cover 80 of 88/);
	});

	it("accepts an empty range at any position", () => {
		const links = linksFromRanges(
			{ words: srcWords, ranges: [{ start: 0, end: 66 }, { start: 999, end: 999 }] },
			{ words: tgtWords, ranges: [{ start: 0, end: 81 }, { start: 81, end: 88 }] },
			[false, false],
		);
		expect(links[1]?.src).toBeNull();
	});

	it("requires parallel inputs", () => {
		expect(() => linksFromRanges({ words: srcWords, ranges: [{ start: 0, end: 3 }] }, { words: tgtWords, ranges: [] }, [false])).toThrow(RangeError);
	});
});

describe("sideOf", () => {
	it("returns one side's signatures in link order", () => {
		const parsed = parseMenardLine(DESIGN_VARIANTS[4] as string) as Extract<MenardLine, { kind: "map" }>;
		expect(sideOf(parsed.links, "src")).toEqual([{ count: 33, hash: "myfp" }, { count: 33, hash: "7teg" }, null]);
		expect(sideOf(parsed.links, "tgt").map((s) => s?.count)).toEqual([46, 35, 7]);
	});
});
