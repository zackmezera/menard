import { describe, expect, it } from "vitest";
import { planSplit } from "../../src/jobs/split-plan";
import type { SplitPlan } from "../../src/jobs/split-plan";
import type { ParseOptions } from "../../src/types";
import { parseNote, textUnits } from "../../src/text/blocks";
import { LAYOUT_A, LAYOUT_B, LAYOUT_C, LAYOUT_D } from "./fixtures";

const OPTIONS: ParseOptions = {
	textStartHeading: "Text",
	skipHeadings: ["Bibliografía", "Bibliography", "Argument", "For My Work"],
};

function plan(text: string, options: ParseOptions = OPTIONS): SplitPlan {
	const result = planSplit(text, "English translation", options);
	if (!result.ok) throw new Error(result.reason);
	return result.plan;
}

describe("planSplit", () => {
	it("splits at an H1 boundary and stops at the trailing personal section (layout a)", () => {
		const { sourceText, translationBody, renamedFootnotes, movedBlocks, movedFootnotes } = plan(LAYOUT_A);
		expect(sourceText).not.toContain("English translation");
		expect(sourceText).not.toContain("According to Mr Pérez");
		expect(sourceText).toContain("# For My Work\n\nCompare with the seminar notes on Genette.\n");
		expect(sourceText).toContain("[^2]: Sobre la recepción, cf. Molloy, *Las letras de Borges*, cap. 3.\n\n# For My Work");
		expect(translationBody.startsWith("> [!info] Translated by the author for this edition.\n\n## I. The labyrinth as form\n\nAccording to Mr Pérez")).toBe(true);
		expect(translationBody).toContain("around 1916.[^1] That reading");
		expect(translationBody).toContain("[^2]: On the reception");
		expect(translationBody).not.toContain("en-");
		expect(translationBody.endsWith("ch. 3.\n")).toBe(true);
		expect(renamedFootnotes).toEqual({ "en-1": "1", "en-2": "2" });
		expect(movedBlocks).toBe(7);
		expect(movedFootnotes).toBe(2);
	});

	it("renames gen- labels and keeps the Argument section in the source (layout b)", () => {
		const { sourceText, translationBody, renamedFootnotes } = plan(LAYOUT_B);
		expect(renamedFootnotes).toEqual({ "gen-1": "1" });
		expect(translationBody).toBe(
			"> Resistance is not a gesture,\n> it is a way of lasting.\n\nNational University of Rosario\n\n## Resistance as reading\n\nReading resists time.[^1] The text, by contrast, gives itself up.\n\n[^1]: Giordano, *Modos del ensayo*, p. 44.\n",
		);
		expect(sourceText.endsWith("[^1]: Giordano, *Modos del ensayo*, p. 44.\n\n# Argument\n\nThe essay argues that reading is a form of endurance.\n")).toBe(true);
	});

	it("splits at an H2 boundary running to the end of the note (layout c)", () => {
		const { sourceText, translationBody, renamedFootnotes } = plan(LAYOUT_C, { textStartHeading: "", skipHeadings: [] });
		expect(sourceText.endsWith("---\n\n[^1]: Nota del autor.\n")).toBe(true);
		expect(translationBody).toBe("An old habit of our letters %%p. 45%% turns style into ornament. Buenos Aires, 1930.\n\n1930\n");
		expect(renamedFootnotes).toEqual({});
	});

	it("refuses an English-only note (layout d)", () => {
		const result = planSplit(LAYOUT_D, "English translation", { textStartHeading: "", skipHeadings: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("no source text");
	});

	it("refuses a note without the boundary heading", () => {
		const result = planSplit("# Texto\n\nSolo hay texto en castellano.\n", "English translation", OPTIONS);
		expect(result).toEqual({ ok: false, reason: "This note has no “English translation” heading." });
	});

	it("refuses an empty translation section", () => {
		const result = planSplit("Un párrafo en castellano.\n\n# English translation\n\n# For My Work\n\nNotas.\n", "English translation", OPTIONS);
		expect(result).toEqual({ ok: false, reason: "There is no text under the translation heading." });
	});

	it("does not rename when the translation also cites a source footnote, which it gets a copy of", () => {
		const text = "Uno.[^1] Dos.[^2]\n\n[^1]: a\n[^2]: b\n\n# English translation\n\nOne.[^en-1] Two.[^en-2]\n\n[^en-1]: a\n[^en-2]: b\n";
		expect(planSplit(text, "English translation", { textStartHeading: "", skipHeadings: [] }).ok).toBe(true);
		const citing = "Uno.[^1]\n\n[^1]: a\n\n# English translation\n\nOne.[^en-1] Also the source note.[^1]\n\n[^en-1]: a\n";
		const result = plan(citing, { textStartHeading: "", skipHeadings: [] });
		expect(result.renamedFootnotes).toEqual({});
		expect(result.sourceText).toBe("Uno.[^1]\n\n[^1]: a\n");
		expect(result.translationBody).toBe("One.[^en-1] Also the source note.[^1]\n\n[^en-1]: a\n\n[^1]: a\n");
	});

	it("keeps a definition both halves cite in the source and copies it into the translation", () => {
		const text = "Uno.[^1]\n\n# English translation\n\nOne.[^1]\n\n[^1]: Nota compartida.\n";
		const result = plan(text, { textStartHeading: "", skipHeadings: [] });
		expect(result.sourceText).toBe("Uno.[^1]\n\n[^1]: Nota compartida.\n");
		expect(result.translationBody).toBe("One.[^1]\n\n[^1]: Nota compartida.\n");
		expect(result.movedFootnotes).toBe(0);
		expect(result.copiedFootnotes).toBe(1);
	});

	it("counts moved and copied footnotes separately (#31)", () => {
		const text = "Uno.[^1] Dos.[^2]\n\n[^1]: a\n[^2]: b\n\n# English translation\n\nOne.[^en-1] Two.[^2]\n\n[^en-1]: c\n";
		const result = plan(text, { textStartHeading: "", skipHeadings: [] });
		expect(result.movedFootnotes).toBe(1);
		expect(result.copiedFootnotes).toBe(1);
	});

	it("leaves labels alone when stripping the prefix does not give the source's labels", () => {
		const text = "Uno.[^1]\n\n[^1]: a\n\n# English translation\n\nOne.[^en-1] Two.[^en-2]\n\n[^en-1]: a\n[^en-2]: b\n";
		const result = plan(text, { textStartHeading: "", skipHeadings: [] });
		expect(result.renamedFootnotes).toEqual({});
		expect(result.translationBody).toContain("[^en-2]: b");
	});

	it("moves definitions only the translation refers to, wherever they stand, and keeps the source's", () => {
		const text = "# English translation\n\nOne.[^en-1]\n\n# Texto\n\nUno.[^1]\n\n[^1]: a\n[^en-1]: b\n";
		const result = plan(text, { textStartHeading: "", skipHeadings: [] });
		expect(result.sourceText).toBe("# Texto\n\nUno.[^1]\n\n[^1]: a\n");
		expect(result.translationBody).toBe("One.[^1]\n\n[^1]: b\n");
	});

	it("keeps every unit of every layout: source plus translation hold the original's units", () => {
		for (const [text, options] of [
			[LAYOUT_A, OPTIONS],
			[LAYOUT_B, OPTIONS],
			[LAYOUT_C, { textStartHeading: "", skipHeadings: [] }],
		] as [string, ParseOptions][]) {
			const { sourceText, translationBody } = plan(text, options);
			const count = (markdown: string, o: ParseOptions): number => textUnits(parseNote(markdown, o)).length;
			const all = { textStartHeading: options.textStartHeading, skipHeadings: [] };
			expect(count(sourceText, all) + count(translationBody, { textStartHeading: "", skipHeadings: [] }) + 1).toBe(count(text, all));
		}
	});

	it("preserves CRLF line endings", () => {
		const text = "Uno dos tres.\r\n\r\n# English translation\r\n\r\nOne two three.\r\n";
		const result = plan(text, { textStartHeading: "", skipHeadings: [] });
		expect(result.sourceText).toBe("Uno dos tres.\r\n");
		expect(result.translationBody).toBe("One two three.\r\n");
	});
});
