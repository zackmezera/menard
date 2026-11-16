import { describe, expect, it } from "vitest";
import { parseNote, textUnits } from "../../src/text/blocks";
import type { NoteStructure, ParseOptions } from "../../src/types";
import { fixture, privateFixture } from "../fixtures/load";

/** The vault's settings: text starts after "# Text"; bibliographies and the reader's own sections are skipped. */
const VAULT: ParseOptions = {
	textStartHeading: "Text",
	skipHeadings: ["Bibliografía", "Bibliography", "Obras citadas", "Works cited", "Referencias", "References", "Argument", "For My Work"],
};

/** Text units as compact tokens: p paragraph, q quote, c callout, l list, t table, h<level> heading, f:<label> footnote. */
function shape(structure: NoteStructure): string {
	return textUnits(structure)
		.map((b) => {
			if (b.kind === "heading") return `h${b.headingLevel ?? 0}`;
			if (b.kind === "footnote") return `f:${b.footnoteLabel ?? ""}`;
			return b.kind.charAt(0);
		})
		.join(" ");
}

function regionCounts(structure: NoteStructure): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const b of structure.blocks) counts[b.region] = (counts[b.region] ?? 0) + 1;
	return counts;
}

describe("synthetic fixtures", () => {
	it("(a) H1 Text / English translation with bibliography, en- footnotes and trailing user sections", () => {
		const s = parseNote(fixture("combined-h1.md"), VAULT);
		expect(s.frontmatter).toEqual({ start: 0, end: 8 });
		expect(shape(s)).toBe(
			[
				"p p c", // bold title, source-only citation line, Resumen
				"h2 p p q",
				"h2 p p",
				"f:1 f:2",
				"h1 c p c", // English translation, provenance callout, bold title, Abstract
				"h2 p p q",
				"h2 p p",
				"f:en-1 f:en-2",
			].join(" "),
		);
		expect(regionCounts(s)).toEqual({ preamble: 6, text: 25, skipped: 4 });
		const skipped = s.blocks.filter((b) => b.region === "skipped").map((b) => b.body.split("\n")[0]);
		expect(skipped).toEqual(["Bibliografía", "- Morales, Inés. *Otra vez la lectura*. Buenos Aires: Ediciones del Sur, 2015.", "Argument", "For My Work"]);
		const callouts = textUnits(s).filter((b) => b.kind === "callout");
		expect(callouts.map((c) => [c.calloutType, c.calloutTitle])).toEqual([
			["abstract", "Resumen"],
			["note", "Working translation by Claude, not a published translation."],
			["abstract", "Abstract"],
		]);
	});

	it("(b) gen- footnotes, a three-line epigraph and an affiliation line under a heading", () => {
		const s = parseNote(fixture("combined-gen.md"), VAULT);
		expect(shape(s)).toBe(["p p q", "h2 p p q", "f:1 f:2", "h1 c p q", "h2 p p p q", "f:gen-1 f:gen-2"].join(" "));
		const epigraph = textUnits(s).find((b) => b.kind === "quote");
		expect(epigraph?.lines).toEqual({ start: 18, end: 21 });
		expect(epigraph?.body).toBe(
			"... en nuestra manera de leer este fenómeno hay siempre un resto que no se deja nombrar.\n\n— Elena Varela, *Los espejos del sentido*",
		);
		const heading = s.blocks.findIndex((b) => b.body === "A Difficulty of Method");
		const affiliation = s.blocks[heading + 1];
		expect(affiliation?.kind).toBe("paragraph");
		expect(affiliation?.lines.start).toBe((s.blocks[heading]?.lines.end ?? 0));
		expect(affiliation?.body).toBe("*Tomás Suárez — Universidad Nacional del Litoral*");
	});

	it("(c) an H2 English translation inside # Text, with inline page markers and a date line", () => {
		const s = parseNote(fixture("combined-h2.md"), VAULT);
		expect(shape(s)).toBe("p p p p h2 c p p p p");
		const dates = textUnits(s).filter((b) => b.body === "1930");
		expect(dates.map((b) => b.kind)).toEqual(["paragraph", "paragraph"]);
		const withMarkers = textUnits(s).filter((b) => b.body.includes("%%p. 204%%"));
		expect(withMarkers).toHaveLength(2);
		expect(regionCounts(s)).toEqual({ preamble: 3, text: 10, skipped: 2 });
	});

	it("(d) an English-only note with hard wraps, verse quotes, a bare rule and a long footnote", () => {
		const s = parseNote(fixture("english-only.md"), VAULT);
		expect(shape(s)).toBe("p p q p q p f:1");
		const units = textUnits(s);
		expect(units[1]?.lines).toEqual({ start: 13, end: 15 });
		expect(units[2]?.body.split("\n")).toHaveLength(4);
		expect(units[4]?.body.split("\n")[2]).toBe("[a gloss: the quay is the old one, since demolished]");
		const rule = s.blocks.find((b) => b.raw === "---" && b.region === "text");
		expect(rule?.kind).toBe("verbatim");
		const note = units[6];
		expect(note?.lines).toEqual({ start: 32, end: 40 });
		expect(note?.body.endsWith("> The rope is long, the morning short,\n> and every version leaves the port.")).toBe(true);
	});

	it("Quijote and Ormsby: one paragraph each with ^p1, and the translation's map", () => {
		const es = parseNote(fixture("quijote-es.md"), VAULT);
		const en = parseNote(fixture("quijote-en.md"), VAULT);
		expect(shape(es)).toBe("p");
		expect(es.blocks[0]?.id).toBe("p1");
		expect(es.blocks[0]?.body.endsWith("las tres partes de su hacienda.")).toBe(true);
		expect(en.blocks.map((b) => b.kind)).toEqual(["paragraph", "menard"]);
		expect(en.blocks[0]?.id).toBe("p1");
	});
});

const PRIVATE = ["@ruizalmotasim.md", "@giordanoresistencia.md", "@borgessupersticiosa1932.md", "@borgesversiones1932.md"];

describe.skipIf(PRIVATE.every((name) => privateFixture(name) === null))("private vault notes", () => {
	it.each(PRIVATE)("%s parses into text units without Menard lines or stray ids", (name) => {
		const text = privateFixture(name);
		if (text === null) return;
		const s = parseNote(text, VAULT);
		expect(textUnits(s).length).toBeGreaterThan(5);
		expect(s.blocks.some((b) => b.kind === "menard")).toBe(false);
		expect(s.blocks.find((b) => b.region === "text")?.body.startsWith("**")).toBe(true);
	});
});
