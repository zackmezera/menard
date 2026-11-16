import { describe, expect, it } from "vitest";
import { serializeMenardLine } from "../../src/align/map";
import { assemblePlainUnit, assembleSentenceUnit, prepareSentenceUnit, protectSlices, rulesFor, wordRangeOf } from "../../src/jobs/assemble";
import { wordsOf } from "../../src/align/words";
import { abbreviationsFor } from "../../src/text/abbreviations";
import { parseNote } from "../../src/text/blocks";
import type { Block, TranslateOutput } from "../../src/types";
import { QUIJOTE_EN, QUIJOTE_EN_1, QUIJOTE_EN_2, QUIJOTE_ES } from "./fixtures";

const ES = { lang: "es", abbreviations: abbreviationsFor("es", ""), splitDialogue: false };

function firstBlock(markdown: string): Block {
	const block = parseNote(markdown, { textStartHeading: "", skipHeadings: [] }).blocks[0];
	if (block === undefined) throw new Error("no block");
	return block;
}

/** Prepares a unit and assembles the given groups (protected Markdown) against it. */
function assemble(markdown: string, groups: TranslateOutput["groups"], calloutTitle?: string): { block: string; map: string } {
	const block = firstBlock(markdown);
	const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
	const output: TranslateOutput = calloutTitle === undefined ? { groups } : { groups, calloutTitle };
	const result = assembleSentenceUnit({ key: block.id ?? "p1", block, sentences: prepared.sentences, tokens: prepared.tokens }, output, "\n");
	return { block: result.block, map: serializeMenardLine(result.map) };
}

describe("prepareSentenceUnit", () => {
	it("cuts the Quijote paragraph into two protected sentences with unit-wide placeholders", () => {
		const block = firstBlock(QUIJOTE_ES);
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		expect(prepared.protectedSentences).toHaveLength(2);
		expect(prepared.protectedSentences[0]).toMatch(/galgo corredor\.⟦\^1⟧ $/);
		expect(prepared.protectedSentences[1]).toContain("palomino de ⟦C1⟧ añadidura");
		expect(prepared.tokens).toEqual([
			{ placeholder: "⟦^1⟧", original: "[^1]" },
			{ placeholder: "⟦C1⟧", original: "%%p. 2%%" },
		]);
	});

	it("keeps abbreviations, initials and page references inside one sentence", () => {
		const block = firstBlock("Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra. Esa lectura, dice, fue decisiva. ^p4");
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		expect(prepared.protectedSentences).toEqual(["Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra. ", "Esa lectura, dice, fue decisiva."]);
	});

	it("turns quote line breaks into placeholders", () => {
		const block = firstBlock("> «Yo soy el que soy»,\n> dijo el Señor.\n>\n> —Éxodo 3, 14");
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		expect(prepared.protectedSentences.join("")).toBe("«Yo soy el que soy»,⟦BR⟧dijo el Señor.⟦P⟧—Éxodo 3, 14");
	});
});

describe("protectSlices", () => {
	it("renumbers numbered placeholders across slices and shares footnote placeholders", () => {
		const { texts, tokens } = protectSlices(["Uno %%a%% `x` [^2]. ", "Dos %%b%% `y` [^2]."], "keep");
		expect(texts).toEqual(["Uno ⟦C1⟧ ⟦V1⟧ ⟦^2⟧. ", "Dos ⟦C2⟧ ⟦V2⟧ ⟦^2⟧."]);
		expect(tokens.map((t) => `${t.placeholder}=${t.original}`)).toEqual(["⟦C1⟧=%%a%%", "⟦V1⟧=`x`", "⟦^2⟧=[^2]", "⟦C2⟧=%%b%%", "⟦V2⟧=`y`"]);
	});
});

describe("assembleSentenceUnit", () => {
	it("reproduces the DESIGN §4.3 Quijote translation and map byte for byte", () => {
		const result = assemble(QUIJOTE_ES, [
			{ src: [1], markdown: QUIJOTE_EN_1 },
			{ src: [2], markdown: QUIJOTE_EN_2 },
		]);
		expect(result.block).toBe(QUIJOTE_EN);
		expect(result.map).toBe("%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%");
	});

	it("keeps the source's line break between sentences (verse)", () => {
		const stanza = "¿Y fue por este río de sueñera y de barro  \nque las proas vinieron a fundarme la patria?  \nIrían a los tumbos los barquitos pintados  \nentre los camalotes de la corriente zaina. ^p1";
		const result = assemble(stanza, [
			{ src: [1], markdown: "And was it along this river of drowsiness and mud  \nthat the prows came to found my homeland?" },
			{ src: [2], markdown: "The little painted boats must have gone tossing and pitching  \namong the water hyacinths of the dusky-brown current." },
		]);
		expect(result.block).toBe(
			"And was it along this river of drowsiness and mud  \nthat the prows came to found my homeland?  \nThe little painted boats must have gone tossing and pitching  \namong the water hyacinths of the dusky-brown current. ^p1",
		);
	});

	it("joins with a space when the source sentences share a line", () => {
		const result = assemble("Uno dos tres.  Cuatro cinco seis. ^p1", [
			{ src: [1], markdown: "One two three." },
			{ src: [2], markdown: "Four five six." },
		]);
		expect(result.block).toBe("One two three. Four five six. ^p1");
	});

	it("records a one-to-many link as one link (1→n)", () => {
		const split = QUIJOTE_EN_2.replace("on Sundays, made away", "on Sundays. These made away");
		const result = assemble(QUIJOTE_ES, [
			{ src: [1], markdown: QUIJOTE_EN_1 },
			{ src: [2], markdown: split },
		]);
		expect(result.map).toBe("%%menard:1 p1 33.myfp/46.6ton 33.7teg/36.xsyq%%");
	});

	it("records two fused sentences as one link (n→1)", () => {
		const fused =
			"In a village of La Mancha whose name I have no wish to recall there lived not long ago a gentleman of lance and old shield ⟦^1⟧ with a lean nag and a fast greyhound whose stews of beef and salads and scraps and lentils and pigeon ⟦C1⟧ ate up three quarters of all that he had in the world, every single year.";
		const result = assemble(QUIJOTE_ES, [{ src: [1, 2], markdown: fused }]);
		expect(result.map).toMatch(/^%%menard:1 p1 66\.j87o\/61\.[0-9a-z]{4}%%$/);
		expect(result.block).toContain("gentleman of lance and old shield [^1] with");
	});

	it("records a translator's addition as a link with an empty source side", () => {
		const result = assemble(QUIJOTE_ES, [
			{ src: [1], markdown: QUIJOTE_EN_1 },
			{ src: [2], markdown: QUIJOTE_EN_2 },
			{ src: [], markdown: "[An olla is a slow-cooked stew.]" },
		]);
		expect(result.map).toBe("%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r -/7.e5eo%%");
		expect(result.block.endsWith("his income. [An olla is a slow-cooked stew.] ^p1")).toBe(true);
	});

	it("rebuilds quote prefixes, the blank quote line and an own-line id", () => {
		const result = assemble("> «Yo soy el que soy»,\n> dijo el Señor.\n>\n> —Éxodo 3, 14\n\n^p7", [
			{ src: [1], markdown: "“I am who I am,”⟦BR⟧" },
			{ src: [2], markdown: "said the Lord.⟦P⟧" },
			{ src: [3], markdown: "—Exodus 3:14" },
		]);
		expect(result.block).toBe("> “I am who I am,”\n> said the Lord.\n>\n> —Exodus 3:14\n\n^p7");
		expect(result.map).toMatch(/^%%menard:1 p7 \S+ \S+ \S+%%$/);
		expect(result.map).toContain(" 5.");
	});

	it("rebuilds a callout header with its fold marker and the translated title", () => {
		const result = assemble("> [!quote]- Nota del editor\n> La primera edición es de 1944. Fue revisada en 1956.\n\n^p9", [
			{ src: [1], markdown: "The first edition is from 1944." },
			{ src: [2], markdown: "It was revised in 1956." },
		], "Editor's note");
		expect(result.block).toBe("> [!quote]- Editor's note\n> The first edition is from 1944. It was revised in 1956.\n\n^p9");
		expect(result.map).toMatch(/^%%menard:1 p9 \d\.\w{4}\/6\.\w{4} \d\.\w{4}\/5\.\w{4}%%$/);
	});

	it("uses the note's line ending", () => {
		const result = assemble("> Primera línea del poema,\n> segunda línea del poema.\n\n^p2", [
			{ src: [1], markdown: "First line of the poem,⟦BR⟧" },
			{ src: [2], markdown: "second line of the poem." },
		]);
		expect(result.block.split("\n")).toHaveLength(4);
		const block = firstBlock("> Primera línea del poema,\r\n> segunda línea del poema.\r\n\r\n^p2");
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		const crlf = assembleSentenceUnit(
			{ key: "p2", block, sentences: prepared.sentences, tokens: prepared.tokens },
			{ groups: [{ src: [1], markdown: "First line of the poem,⟦BR⟧" }, { src: [2], markdown: "second line of the poem." }] },
			"\r\n",
		);
		expect(crlf.block).toBe("> First line of the poem,\r\n> second line of the poem.\r\n\r\n^p2");
	});
});

describe("assemblePlainUnit", () => {
	it("writes a footnote definition with indented continuation lines", () => {
		const note = "[^3]: Véase *Otras inquisiciones*, p. 12.\n    Borges vuelve sobre el tema en 1951.\n\n    > «El tiempo es la sustancia de que estoy hecho.»";
		const block = firstBlock(note);
		const text = assemblePlainUnit(
			"fn:3",
			block,
			"See *Other Inquisitions*, p. 12.\nBorges returns to the subject in 1951.\n\n> “Time is the substance I am made of.”",
			[],
			"\n",
		);
		expect(text).toBe(
			"[^3]: See *Other Inquisitions*, p. 12.\n    Borges returns to the subject in 1951.\n\n    > “Time is the substance I am made of.”",
		);
	});

	it("writes a list with its id on its own line and restores placeholders", () => {
		const block = firstBlock("- Primera edición: 1944\n- Segunda edición: 1956 [^2]\n\n^p5");
		const text = assemblePlainUnit("p5", block, "- First edition: 1944\n- Second edition: 1956 ⟦^2⟧", [{ placeholder: "⟦^2⟧", original: "[^2]" }], "\n");
		expect(text).toBe("- First edition: 1944\n- Second edition: 1956 [^2]\n\n^p5");
	});
});

describe("rulesFor and wordRangeOf", () => {
	it("treats line breaks as spaces in paragraphs and as boundaries in quotes", () => {
		expect(rulesFor(firstBlock("Una frase."), ES).lineBreaks).toBe("space");
		expect(rulesFor(firstBlock("> Un verso."), ES).lineBreaks).toBe("boundary");
		expect(rulesFor(firstBlock("> [!note]\n> Un verso."), ES).lineBreaks).toBe("boundary");
	});

	it("finds the words starting inside a character range", () => {
		const words = wordsOf("Uno dos. Tres cuatro.");
		expect(wordRangeOf(words, 0, 9)).toEqual({ start: 0, end: 2 });
		expect(wordRangeOf(words, 9, 21)).toEqual({ start: 2, end: 4 });
	});
});
