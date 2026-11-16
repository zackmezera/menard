import { describe, expect, it } from "vitest";
import { buildPairModel, footnoteKey } from "../../src/align/model";
import type { PairModel } from "../../src/types";
import { block, note } from "./helpers";

const source = note([
	block({ kind: "heading", line: 0, raw: "# Ruiz, «El acercamiento»", region: "preamble", headingLevel: 1 }),
	block({ kind: "heading", line: 2, raw: "# Text", region: "preamble", headingLevel: 1 }),
	block({ kind: "heading", line: 4, raw: "## I", headingLevel: 2 }),
	block({
		kind: "paragraph",
		line: 6,
		raw: "Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra.[^1]\nEsa lectura, dice, fue *decisiva*.",
		id: "p1",
	}),
	block({ kind: "quote", line: 9, raw: "> Era un hombre alto,\n> de mirada esquiva,\n> — Borges", id: "p2", idStyle: "own-line" }),
	block({ kind: "paragraph", line: 15, raw: "La reseña de una novela inexistente (Ruiz 2002, p. 14) funciona como ficción.", id: "p3" }),
	block({ kind: "paragraph", line: 17, raw: "Un párrafo nuevo, todavía sin id." }),
	block({ kind: "heading", line: 19, raw: "## II", headingLevel: 2 }),
	block({ kind: "list", line: 21, raw: "- *Ficciones* (1944)\n- *El Aleph* (1949)", id: "p4", idStyle: "own-line" }),
	block({ kind: "footnote", line: 26, raw: "[^1]: Véase [[Molloy, Sylvia]], *Las letras de Borges*.", footnoteLabel: "1" }),
	block({ kind: "footnote", line: 27, raw: "[^2]: Cf. Balderston 1993.", footnoteLabel: "2" }),
	block({ kind: "heading", line: 29, raw: "## Bibliografía", region: "skipped", headingLevel: 2 }),
	block({ kind: "paragraph", line: 31, raw: "Ruiz, A. (2002). *Borges y la reseña*.", region: "skipped", id: "p9" }),
]);

const target = note([
	block({ kind: "heading", line: 4, raw: "## I", headingLevel: 2 }),
	block({ kind: "callout", line: 6, raw: "> [!info] Provenance\n> Translated from the 2002 edition.", id: "intro-note", idStyle: "own-line" }),
	block({ kind: "paragraph", line: 11, raw: "According to Mr. Pérez (cf. pp. 23-25), J. L. Borges read Poe in Geneva.[^1]\nThat reading, he says, was *decisive*.", id: "p1" }),
	block({ kind: "menard", line: 14, raw: "%%menard:1 p1 15.aaaa/14.bbbb 5.cccc/6.dddd%%" }),
	block({ kind: "quote", line: 16, raw: "> He was a tall man,\n> of evasive gaze,\n> — Borges", id: "p2", idStyle: "own-line" }),
	block({ kind: "menard", line: 22, raw: "%%menard:1 p2 -/3.eeee 11.ffff/12.gggg?%%" }),
	block({ kind: "menard", line: 24, raw: "%%menard:1 p3 translate%%" }),
	block({ kind: "heading", line: 26, raw: "## II", headingLevel: 2 }),
	block({ kind: "list", line: 28, raw: "- *Ficciones* (1944)\n- *The Aleph* (1949)", id: "p4", idStyle: "own-line" }),
	block({ kind: "menard", line: 33, raw: "%%menard:1 p4 4.hhhh/4.iiii%%" }),
	block({ kind: "menard", line: 35, raw: "%%menard:1 p1 3.abcd%%" }),
	block({ kind: "menard", line: 37, raw: "%%menard:1 p9 3.abcd/3.abcd%%" }),
	block({ kind: "menard", line: 39, raw: "%%menard:1 p8 align%%" }),
	block({ kind: "menard", line: 41, raw: "%%menard:1 p1 20.aaaa/20.bbbb%%" }),
	block({ kind: "footnote", line: 43, raw: "[^en-1]: See [[Molloy, Sylvia]], *Signs of Borges*.", footnoteLabel: "en-1" }),
	block({ kind: "footnote", line: 44, raw: "[^en-3]: Translator's note.", footnoteLabel: "en-3" }),
	block({ kind: "menard", line: 46, raw: "%%menard:1 fn:2 translate%%" }),
]);

const model: PairModel = buildPairModel({
	sourcePath: "Collections/Texts/@ruizalmotasim.md",
	targetPath: "Collections/Texts/@ruizalmotasim (EN).md",
	languages: { source: "es", target: "en" },
	version: 7,
	source,
	target,
});

describe("footnoteKey", () => {
	it.each([
		["3", "fn:3"],
		["en-3", "fn:3"],
		["gen-3", "fn:3"],
		["gen-12", "fn:12"],
		["nota", "fn:nota"],
		["en-3a", "fn:en-3a"],
		["a-b-3", "fn:a-b-3"],
		["en_3", "fn:en_3"],
	])("%s gives %s", (label, key) => {
		expect(footnoteKey(label)).toBe(key);
	});
});

describe("buildPairModel", () => {
	it("passes identity, languages and version through", () => {
		expect(model.sourcePath).toBe("Collections/Texts/@ruizalmotasim.md");
		expect(model.targetPath).toBe("Collections/Texts/@ruizalmotasim (EN).md");
		expect(model.languages).toEqual({ source: "es", target: "en" });
		expect(model.version).toBe(7);
	});

	it("orders units by source, placing translation-only units after their predecessor", () => {
		expect(model.units.map((u) => u.key)).toEqual(["h:1", "intro-note", "p1", "p2", "p3", "h:2", "p4", "fn:1", "fn:3", "fn:2"]);
	});

	it("pairs by block id, footnote key and heading ordinal, ignoring the preamble, skipped sections and id-less blocks", () => {
		const paired = model.units.filter((u) => u.source !== null && u.target !== null).map((u) => u.key);
		expect(paired).toEqual(["h:1", "p1", "p2", "h:2", "p4", "fn:1"]);
		expect(model.unit("fn:1")?.target?.footnoteLabel).toBe("en-1");
		expect(model.unit("h:1")?.source?.lines.start).toBe(4);
		expect(model.unit("p9")).toBeUndefined();
		expect(model.unit("intro-note")).toMatchObject({ kind: "callout", source: null });
		expect(model.unit("p3")).toMatchObject({ target: null, pending: "translate" });
		expect(model.unit("fn:2")).toMatchObject({ target: null, pending: "translate" });
	});

	it("attaches sentence maps to sentence units only", () => {
		expect(model.unit("p1")?.map?.links).toHaveLength(2);
		expect(model.unit("p2")?.map?.links[1]).toEqual({ src: { count: 11, hash: "ffff" }, tgt: { count: 12, hash: "gggg" }, loose: true });
		expect(model.unit("p4")?.map).toBeNull();
	});

	it("reports malformed, orphaned, misplaced and duplicate Menard lines", () => {
		expect(model.problems.map((p) => [p.line, p.error])).toEqual([
			[33, 'sentence map for "p4", a list, which aligns whole'],
			[35, expect.stringMatching(/link 1 \("3\.abcd"\)/)],
			[37, 'sentence map for "p9", which has no unit in the translation note'],
			[39, '"align" marker for "p8", which has no unit in the source note'],
			[41, 'duplicate sentence map for "p1"; the first one is used'],
		]);
		expect(model.problems[1]?.parsed).toBeNull();
		expect(model.problems[2]?.parsed).toMatchObject({ kind: "map", key: "p9" });
	});

	it("finds the unit at a line, including own-line ids and the map line", () => {
		expect(model.unitAtLine("source", 7)?.key).toBe("p1");
		expect(model.unitAtLine("source", 13)?.key).toBe("p2");
		expect(model.unitAtLine("target", 20)?.key).toBe("p2");
		expect(model.unitAtLine("target", 14)?.key).toBe("p1");
		expect(model.unitAtLine("target", 22)?.key).toBe("p2");
		expect(model.unitAtLine("target", 7)?.key).toBe("intro-note");
		expect(model.unitAtLine("source", 26)?.key).toBe("fn:1");
		expect(model.unitAtLine("source", 4)?.key).toBe("h:1");
		for (const [side, line] of [["source", 12], ["source", 17], ["source", 31], ["target", 24], ["target", 41], ["source", 999]] as const) {
			expect(model.unitAtLine(side, line)).toBeUndefined();
		}
	});

	it("gives one stop per link with a source side, or one per unit, skipping headings, footnotes and translation-only units", () => {
		expect(model.stops()).toEqual([
			{ unit: "p1", link: 1 },
			{ unit: "p1", link: 2 },
			{ unit: "p2", link: 2 },
			{ unit: "p3", link: null },
			{ unit: "p4", link: null },
		]);
		expect(model.stops()).toBe(model.stops());
	});

	it("anchors paired units and headings on both sides", () => {
		expect(model.anchors()).toEqual([
			{ key: "h:1", source: { start: 4, end: 5 }, target: { start: 4, end: 5 } },
			{ key: "p1", source: { start: 6, end: 8 }, target: { start: 11, end: 13 } },
			{ key: "p2", source: { start: 9, end: 14 }, target: { start: 16, end: 21 } },
			{ key: "h:2", source: { start: 19, end: 20 }, target: { start: 26, end: 27 } },
			{ key: "p4", source: { start: 21, end: 25 }, target: { start: 28, end: 32 } },
			{ key: "fn:1", source: { start: 26, end: 27 }, target: { start: 43, end: 44 } },
		]);
	});

	it("refuses a map for a unit whose source block aligns whole, even if the translation is a paragraph", () => {
		const m = buildPairModel({
			sourcePath: "a.md",
			targetPath: "b.md",
			languages: { source: "es", target: "en" },
			version: 1,
			source: note([block({ kind: "list", line: 0, raw: "- uno\n- dos", id: "p1", idStyle: "own-line" })]),
			target: note([
				block({ kind: "paragraph", line: 0, raw: "One, two.", id: "p1" }),
				block({ kind: "menard", line: 2, raw: "%%menard:1 p1 2.abcd/2.efgh%%" }),
			]),
		});
		expect(m.unit("p1")).toMatchObject({ kind: "list", map: null });
		expect(m.stops()).toEqual([{ unit: "p1", link: null }]);
		expect(m.problems.map((p) => p.error)).toEqual(['sentence map for "p1", a list, which aligns whole']);
	});

	it("keeps the first block when a note repeats a key", () => {
		const repeated = note([
			block({ kind: "paragraph", line: 0, raw: "Primero.", id: "p1" }),
			block({ kind: "paragraph", line: 2, raw: "Segundo.", id: "p1" }),
		]);
		const m = buildPairModel({ sourcePath: "a.md", targetPath: "b.md", languages: { source: "es", target: "en" }, version: 1, source: repeated, target: note([]) });
		expect(m.units).toHaveLength(1);
		expect(m.unit("p1")?.source?.raw).toBe("Primero.");
	});

	it("falls back to a whole-unit stop when a map flags every source side, and leads with translation-only units", () => {
		const m = buildPairModel({
			sourcePath: "a.md",
			targetPath: "b.md",
			languages: { source: "es", target: "en" },
			version: 1,
			source: note([block({ kind: "paragraph", line: 0, raw: "Texto.", id: "p1" })]),
			target: note([
				block({ kind: "paragraph", line: 0, raw: "Translator's preface.", id: "pre" }),
				block({ kind: "paragraph", line: 2, raw: "Text.", id: "p1" }),
				block({ kind: "menard", line: 4, raw: "%%menard:1 p1 -/1.abcd%%" }),
				block({ kind: "menard", line: 6, raw: "%%menard:1 p1 align%%" }),
				block({ kind: "menard", line: 8, raw: "%%menard:1 p1 translate%%" }),
			]),
		});
		expect(m.units.map((u) => u.key)).toEqual(["pre", "p1"]);
		expect(m.stops()).toEqual([{ unit: "p1", link: null }]);
		expect(m.unit("p1")?.pending).toBe("align");
		expect(m.problems.map((p) => p.error)).toEqual(['duplicate marker for "p1"; the first one is used']);
	});

	describe("heading pairing", () => {
		// Shaped like the vault's real notes: the source keeps its title and "Text" headings in the
		// text region and ends with a bibliography heading; the translation has only the section
		// headings plus one heading of its own.
		const realSource = note([
			block({ kind: "heading", line: 0, raw: "# Título", headingLevel: 1 }),
			block({ kind: "heading", line: 2, raw: "# Text", headingLevel: 1 }),
			block({ kind: "heading", line: 4, raw: "## A", headingLevel: 2 }),
			block({ kind: "paragraph", line: 6, raw: "Uno.", id: "p1" }),
			block({ kind: "paragraph", line: 8, raw: "Dos.", id: "p2" }),
			block({ kind: "heading", line: 10, raw: "## B", headingLevel: 2 }),
			block({ kind: "paragraph", line: 12, raw: "Tres.", id: "p3" }),
			block({ kind: "heading", line: 14, raw: "## Bibliografía", headingLevel: 2 }),
			block({ kind: "paragraph", line: 16, raw: "Ruiz, A. (2002).", id: "p9" }),
		]);
		const realTarget = note([
			block({ kind: "heading", line: 0, raw: "## Translator's note", headingLevel: 2 }),
			block({ kind: "paragraph", line: 2, raw: "Translated from the 2002 edition.", id: "tn" }),
			block({ kind: "heading", line: 4, raw: "## A'", headingLevel: 2 }),
			block({ kind: "paragraph", line: 6, raw: "One.", id: "p1" }),
			block({ kind: "paragraph", line: 8, raw: "Two.", id: "p2" }),
			block({ kind: "heading", line: 10, raw: "## B'", headingLevel: 2 }),
			block({ kind: "paragraph", line: 12, raw: "Three.", id: "p3" }),
		]);
		const m = buildPairModel({ sourcePath: "a.md", targetPath: "b.md", languages: { source: "es", target: "en" }, version: 1, source: realSource, target: realTarget });
		const headingPairs = m.units
			.filter((u) => u.kind === "heading")
			.map((u) => [u.key, u.source?.raw ?? null, u.target?.raw ?? null]);

		it("pairs each heading through the next paired paragraph, not by ordinal", () => {
			expect(headingPairs).toEqual([
				["h:t1", null, "## Translator's note"],
				["h:1", "# Título", null],
				["h:2", "# Text", null],
				["h:3", "## A", "## A'"],
				["h:4", "## B", "## B'"],
				["h:5", "## Bibliografía", null],
			]);
		});

		it("anchors only the matched headings, so scroll sync never jumps to the wrong one", () => {
			expect(m.anchors().filter((a) => a.key.startsWith("h:")).map((a) => [a.key, a.source.start, a.target.start])).toEqual([
				["h:3", 4, 4],
				["h:4", 10, 10],
			]);
		});

		it("leaves a heading unpaired when its next paragraph is paired under a different heading", () => {
			const extra = buildPairModel({
				sourcePath: "a.md",
				targetPath: "b.md",
				languages: { source: "es", target: "en" },
				version: 1,
				source: note([
					block({ kind: "heading", line: 0, raw: "## A", headingLevel: 2 }),
					block({ kind: "paragraph", line: 2, raw: "Uno.", id: "p1" }),
					block({ kind: "paragraph", line: 4, raw: "Dos.", id: "p2" }),
				]),
				target: note([
					block({ kind: "heading", line: 0, raw: "## A'", headingLevel: 2 }),
					block({ kind: "paragraph", line: 2, raw: "One.", id: "p1" }),
					block({ kind: "heading", line: 4, raw: "## Interlude", headingLevel: 2 }),
					block({ kind: "paragraph", line: 6, raw: "Two.", id: "p2" }),
				]),
			});
			expect(extra.units.map((u) => [u.key, u.source !== null, u.target !== null])).toEqual([
				["h:1", true, true],
				["p1", true, true],
				["h:t2", false, true],
				["p2", true, true],
			]);
		});
	});
});
