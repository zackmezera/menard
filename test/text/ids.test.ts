import { describe, expect, it } from "vitest";
import { parseNote } from "../../src/text/blocks";
import { applyInserts, isInsertOnly } from "../../src/text/edits";
import { allocateIds, idInserts } from "../../src/text/ids";
import type { Block, NoteStructure, ParseOptions } from "../../src/types";
import { fixture } from "../fixtures/load";

const ALL_TEXT: ParseOptions = { textStartHeading: "", skipHeadings: [] };

/** Gives every id-less paragraph, quote, callout, list and table an id, and returns the new text. */
function withIds(text: string): { text: string; structure: NoteStructure; assigned: Map<number, string> } {
	const structure = parseNote(text, ALL_TEXT);
	const targets = structure.blocks.filter((b) => b.id === null && ["paragraph", "quote", "callout", "list", "table"].includes(b.kind));
	const ids = allocateIds(structure, targets.length);
	const assignments = targets.map((block, k) => ({ block, id: ids[k] ?? "" }));
	const inserts = idInserts(text, structure, assignments);
	const after = applyInserts(text, inserts);
	expect(isInsertOnly(text, after, inserts)).toBe(true);
	return { text: after, structure, assigned: new Map(assignments.map(({ block, id }) => [block.lines.start, id])) };
}

describe("allocateIds", () => {
	it("starts above the highest p<n> and skips used and reserved ids", () => {
		const structure = parseNote("Uno. ^p3\n\nDos. ^p10\n\nTres. ^intro-1", ALL_TEXT);
		expect(allocateIds(structure, 3)).toEqual(["p11", "p12", "p13"]);
		expect(allocateIds(structure, 2, new Set(["p11", "p14"]))).toEqual(["p15", "p16"]);
	});

	it("reserves but does not count from a p<n> too large to count past", () => {
		const structure = parseNote("Uno. ^p99999999999999999999\n\nDos. ^p4", ALL_TEXT);
		expect(allocateIds(structure, 2)).toEqual(["p5", "p6"]);
	});

	it("does not reuse an id written with trailing whitespace", () => {
		const structure = parseNote("Uno. ^p1  \n\nDos.", ALL_TEXT);
		expect(allocateIds(structure, 1)).toEqual(["p2"]);
	});

	it("starts at p1 in a note without Menard ids", () => {
		expect(allocateIds(parseNote("Texto.", ALL_TEXT), 2)).toEqual(["p1", "p2"]);
		expect(allocateIds(parseNote("Texto.", ALL_TEXT), 0)).toEqual([]);
	});
});

describe("idInserts", () => {
	function single(text: string, id = "p1"): string {
		const structure = parseNote(text, ALL_TEXT);
		const block = structure.blocks[0] as Block;
		return applyInserts(text, idInserts(text, structure, [{ block, id }]));
	}

	it("appends a trailing id to a paragraph's last line", () => {
		expect(single("Primera línea\nsegunda línea.\n\nOtro.")).toBe("Primera línea\nsegunda línea. ^p1\n\nOtro.");
	});

	it("places the id after an inline comment", () => {
		expect(single("Algún palomino de %%p. 2%% añadidura los domingos. %%nota%%")).toBe(
			"Algún palomino de %%p. 2%% añadidura los domingos. %%nota%% ^p1",
		);
	});

	it("keeps a hard break's two spaces and adds the id after one more", () => {
		expect(single("Línea con salto  ")).toBe("Línea con salto   ^p1");
	});

	it.each([
		["at the end of the file", "> Cita.", "> Cita.\n\n^p1"],
		["before a final newline", "> Cita.\n", "> Cita.\n\n^p1\n"],
		["before a blank line", "> Cita.\n\nDespués.", "> Cita.\n\n^p1\n\nDespués."],
		["before two blank lines", "> Cita.\n\n\nDespués.", "> Cita.\n\n^p1\n\n\nDespués."],
		["directly before a heading", "> Cita.\n## Título", "> Cita.\n\n^p1\n\n## Título"],
	])("puts a structured block's id on its own line %s", (_name, text, expected) => {
		expect(single(text)).toBe(expected);
	});

	it("uses the note's EOL", () => {
		expect(single("- uno\r\n- dos\r\n\r\nDespués.\r\n")).toBe("- uno\r\n- dos\r\n\r\n^p1\r\n\r\nDespués.\r\n");
		expect(single("Párrafo.\r\nsigue.\r\n")).toBe("Párrafo.\r\nsigue. ^p1\r\n");
	});

	it("rejects blocks that already have an id, cannot carry one, or get two", () => {
		const text = "Uno. ^x\n\n## Título\n\nDos.";
		const structure = parseNote(text, ALL_TEXT);
		const [withId, heading, plain] = structure.blocks as Block[];
		expect(() => idInserts(text, structure, [{ block: withId as Block, id: "p1" }])).toThrow(/already has/);
		expect(() => idInserts(text, structure, [{ block: heading as Block, id: "p1" }])).toThrow(/cannot carry/);
		expect(() => idInserts(text, structure, [{ block: plain as Block, id: "p1" }, { block: plain as Block, id: "p2" }])).toThrow(/two ids/);
		expect(() => idInserts(text, structure, [{ block: plain as Block, id: "p 1" }])).toThrow(/not a valid/);
	});

	it("round-trips: parseNote reports every id idInserts placed", () => {
		for (const name of ["combined-h1.md", "combined-gen.md", "combined-h2.md", "english-only.md"]) {
			const { text, structure, assigned } = withIds(fixture(name));
			const reparsed = parseNote(text, ALL_TEXT);
			const found = reparsed.blocks.filter((b) => b.id !== null).map((b) => b.id);
			expect(found).toEqual([...assigned.values()]);
			expect(reparsed.blocks.map((b) => b.kind)).toEqual(structure.blocks.map((b) => b.kind));
			expect(reparsed.blocks.map((b) => b.body)).toEqual(structure.blocks.map((b) => b.body));
			expect([...reparsed.usedIds].sort()).toEqual([...assigned.values()].sort());
		}
	});

	it("round-trips on CRLF text", () => {
		const crlf = fixture("combined-gen.md").replace(/\n/g, "\r\n");
		const { text, assigned } = withIds(crlf);
		expect(text.replace(/\r\n/g, "")).not.toContain("\n");
		expect(parseNote(text, ALL_TEXT).blocks.filter((b) => b.id !== null).map((b) => b.id)).toEqual([...assigned.values()]);
	});
});
