import { describe, expect, it } from "vitest";
import { isMenardError } from "../../src/errors";
import { parseNote } from "../../src/text/blocks";
import { applyInserts, applyReplacements, isInsertOnly, lineEnd, lineStarts, locateMenardLines } from "../../src/text/edits";

describe("applyInserts and isInsertOnly", () => {
	it("applies inserts given in any order, keeping array order at one offset", () => {
		const inserts = [
			{ at: 5, text: "!" },
			{ at: 0, text: "«" },
			{ at: 5, text: "»" },
		];
		const after = applyInserts("Hola.", inserts);
		expect(after).toBe("«Hola.!»");
		expect(isInsertOnly("Hola.", after, inserts)).toBe(true);
	});

	it("detects any change that is not exactly the inserts", () => {
		const inserts = [{ at: 4, text: " ^p1" }];
		expect(isInsertOnly("Uno.", "Uno. ^p1", inserts)).toBe(true);
		expect(isInsertOnly("Uno.", "Uno! ^p1", inserts)).toBe(false);
		expect(isInsertOnly("Uno.", "Uno. ^p2", inserts)).toBe(false);
		expect(isInsertOnly("Uno.", " ^p1Uno.", inserts)).toBe(false);
		expect(isInsertOnly("Uno.", "Uno. ^p1\n", inserts)).toBe(false);
		expect(isInsertOnly("Uno.", "Uno. ^p1", [{ at: 9, text: " ^p1" }])).toBe(false);
	});

	it("holds for no inserts only on identical text", () => {
		expect(isInsertOnly("a", "a", [])).toBe(true);
		expect(isInsertOnly("a", "b", [])).toBe(false);
	});

	it("rejects an offset outside the text", () => {
		expect(() => applyInserts("abc", [{ at: 4, text: "x" }])).toThrow(RangeError);
	});
});

describe("applyReplacements", () => {
	const text = "%%menard:1 p1 translate%%\n\nTexto.\n";

	it("replaces non-overlapping ranges given in any order", () => {
		const out = applyReplacements(text, [
			{ from: 27, to: 33, expect: "Texto.", text: "Text." },
			{ from: 0, to: 25, expect: "%%menard:1 p1 translate%%", text: "Translated. ^p1" },
		]);
		expect(out).toBe("Translated. ^p1\n\nText.\n");
	});

	it("throws write-conflict when the expected text differs", () => {
		try {
			applyReplacements(text, [{ from: 27, to: 33, expect: "Textos", text: "x" }]);
			expect.unreachable();
		} catch (error) {
			expect(isMenardError(error, "write-conflict")).toBe(true);
		}
	});

	it("throws write-conflict on overlap or out-of-range", () => {
		const overlapping = [
			{ from: 0, to: 5, expect: "%%men", text: "" },
			{ from: 3, to: 6, expect: "ena", text: "" },
		];
		expect(() => applyReplacements(text, overlapping)).toThrow(/overlaps/);
		expect(() => applyReplacements(text, [{ from: 30, to: 99, expect: "", text: "" }])).toThrow(/outside/);
	});
});

describe("lineStarts and lineEnd", () => {
	it("has one entry per line plus the text length", () => {
		expect(lineStarts("")).toEqual([0, 0]);
		expect(lineStarts("a\nbc\n")).toEqual([0, 2, 5, 5]);
		expect(lineStarts("a\r\nb")).toEqual([0, 3, 4]);
	});

	it("ends each line before its EOL", () => {
		const text = "uno\r\ndos\ntres";
		const starts = lineStarts(text);
		expect([0, 1, 2].map((n) => text.slice(starts[n], lineEnd(text, starts, n)))).toEqual(["uno", "dos", "tres"]);
	});
});

describe("locateMenardLines", () => {
	it("returns whole Menard lines with their keys and content ranges", () => {
		const text = "Texto. ^p1\r\n\r\n%%menard:1 p1 3.abcd/3.efgh%%\r\n\r\n%%menard:1 fn:en-2 translate%%";
		const found = locateMenardLines(text);
		expect(found.map((f) => f.key)).toEqual(["p1", "fn:en-2"]);
		for (const f of found) expect(text.slice(f.from, f.to)).toBe(f.raw);
		expect(found[0]?.raw).toBe("%%menard:1 p1 3.abcd/3.efgh%%");
	});

	it("skips fenced code and lines with other text", () => {
		const text = ["```", "%%menard:1 p1 translate%%", "```", "~~~~", "%%menard:1 p2 translate%%", "~~~", "~~~~", "x %%menard:1 p3 translate%%", "%%menard:1 p4 align%%"].join("\n");
		expect(locateMenardLines(text).map((f) => f.key)).toEqual(["p4"]);
	});

	it("treats an unclosed fence as running to the end of the note, and skips indented lines", () => {
		expect(locateMenardLines("```\n%%menard:1 p1 align%%")).toEqual([]);
		expect(locateMenardLines("Texto.\n\n  %%menard:1 p5 align%%\n")).toEqual([]);
	});

	it("owns a malformed Menard line, so the model can report it", () => {
		expect(locateMenardLines("%%menard:1 p4 3.abcd/-/x%%").map((f) => f.key)).toEqual(["p4"]);
	});

	// #35: a Menard-looking line inside a user's multi-line %% block is the user's text.
	it("skips a Menard-looking line inside a user's %% block, which it does not close", () => {
		const text = ["Texto. ^p1", "", "%%", "Mis notas:", "%%menard:1 p1 align%%", "más notas", "%%", "", "%%menard:1 p2 align%%", ""].join("\n");
		expect(locateMenardLines(text).map((f) => f.key)).toEqual(["p2"]);
		const blocks = parseNote(text, { textStartHeading: "", skipHeadings: [] }).blocks;
		expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "verbatim", "menard"]);
	});

	// #35: trailing whitespace makes a line not Menard's, in every module alike.
	it("does not own a Menard line with trailing whitespace", () => {
		const text = "Texto. ^p1\n\n%%menard:1 p1 align%% \n";
		expect(locateMenardLines(text)).toEqual([]);
		expect(parseNote(text, { textStartHeading: "", skipHeadings: [] }).blocks.map((b) => b.kind)).toEqual(["paragraph", "verbatim"]);
	});
});
