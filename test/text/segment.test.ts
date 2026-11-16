import { describe, expect, it } from "vitest";
import { abbreviationsFor } from "../../src/text/abbreviations";
import { parseNote } from "../../src/text/blocks";
import { projectMarkdown } from "../../src/text/inline";
import { segmentSentences, sentenceMarkdown } from "../../src/text/segment";
import type { SegmentRules } from "../../src/types";
import { fixture } from "../fixtures/load";

const WORDS_RE = /[\p{L}\p{N}\p{M}]+/gu;

function rules(overrides: Partial<SegmentRules> = {}): SegmentRules {
	const lang = overrides.lang ?? "es";
	return { lang, abbreviations: abbreviationsFor(lang, ""), splitDialogue: false, lineBreaks: "space", ...overrides };
}

function sentences(markdown: string, overrides: Partial<SegmentRules> = {}): string[] {
	const projection = projectMarkdown(markdown);
	return segmentSentences(projection, rules(overrides)).map((r) => projection.text.slice(r.start, r.end));
}

function icu(text: string, lang = "es"): string[] {
	return Array.from(new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text), (s) => s.segment);
}

function wordCount(text: string): number {
	return text.match(WORDS_RE)?.length ?? 0;
}

describe("segmentSentences: the merge pass", () => {
	it("gives exactly two sentences for the DESIGN §5.3 example", () => {
		const text = "Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra. Esa lectura, dice, fue decisiva.";
		expect(icu(text)).toHaveLength(6);
		expect(sentences(text)).toEqual([
			"Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra. ",
			"Esa lectura, dice, fue decisiva.",
		]);
	});

	it.each([
		["Sr. before a name", "La carta del Sr. Pérez llegó tarde a Ginebra. Nadie la leyó entonces."],
		["Sra. and Dra. before names", "La Sra. Gómez y la Dra. Ruiz discutieron el punto. Nadie cedió aquella tarde."],
		["Dr. before a name", "El Dr. Varela lo explica en su libro. Lo cito por extenso."],
		["pp. before a number", "El argumento se desarrolla en pp. 23-25 del tomo. Lo retomo más adelante."],
		["p. 14) inside a citation", "La cita (Ruiz 2002, p. 14) lo confirma sin dudas. Sigo con el análisis."],
		["n. 3", "Véase la n. 3 del capítulo primero. Allí se discute el problema."],
		["vol. 2", "Está en el vol. 2 de las obras completas. Allí se discute el problema."],
		["s. XX", "Ocurre en el s. XX y no antes de esa fecha. Allí se discute el problema."],
		["initials J. L. Borges", "Lo afirmó J. L. Borges en una entrevista tardía. Allí se discute el problema."],
		["Ed. before a name", "La edición es de Ed. Sudamericana y circuló poco. Allí se discute el problema."],
		["Trad. before a name", "La versión inglesa, Trad. Norman Thomas, tardó años. Allí se discute el problema."],
	])("does not split at %s", (_name, text) => {
		expect(sentences(text)).toHaveLength(2);
	});

	it.each([
		["cf. before lower case", "Lo dice el autor (cf. el cap. 3) con cautela. Después cambia de tema."],
		["etc. before lower case", "Libros, revistas, etc. y otras cosas semejantes. Después cambia de tema."],
		["an ellipsis character", "Era tarde… Nadie vino a la cita aquella noche."],
		["three periods", "Era tarde... Nadie vino a la cita aquella noche."],
		["closing guillemet and period", "Dijo «basta ya de todo esto». Él calló de pronto."],
		["¡ and ¿", "¡Qué horror fue aquello! ¿Quién lo hizo entonces? Nadie lo sabe todavía."],
		["a parenthetical citation", "Así lo afirma la crítica (Ruiz 2002). Luego cambia de tema sin aviso."],
	])("splits as ICU does at %s", (_name, text) => {
		expect(sentences(text)).toEqual(icu(text));
	});

	it("merges a one-word sentence into its neighbour", () => {
		expect(sentences("Sí. Eso dijo el autor en su prólogo.")).toHaveLength(1);
		expect(sentences("Eso dijo el autor en su prólogo. Basta.")).toHaveLength(1);
	});

	it("uses the user's extra abbreviations", () => {
		const text = "Lo firmó el Lic. Gómez en persona aquel día. Nadie lo discute.";
		expect(sentences(text)).toHaveLength(3);
		expect(sentences(text, { abbreviations: abbreviationsFor("es", "es: lic") })).toHaveLength(2);
	});

	it("applies the English list for English text", () => {
		const text = "As Mr. Pérez notes in vol. 2 of the works, reading is translation. I agree.";
		expect(sentences(text, rules({ lang: "en" }))).toHaveLength(2);
	});
});

describe("segmentSentences: single letters and stray punctuation (#34)", () => {
	// Sentences written for these tests, in the patterns of academic prose.
	it.each([
		["es", "a single-letter variable in italics", "El análisis avanza hacia *d*. Se pregunta entonces por el resto.", 2],
		["en", "a single-letter variable in italics", "The argument moves toward *d*. He asks what remains of it.", 2],
		["es", "letters of an enumeration", "Así lo indica la letra a. Luego viene la letra b. Después, nada más.", 3],
		["es", "a lettered clause", "Véase el inciso b. Allí el autor cambia de tono.", 2],
		["fr", "French points of a list", "Voici le point a. Ensuite vient le point b. Enfin, rien.", 3],
	] as const)("ends a %s sentence after %s", (lang, _name, text, count) => {
		expect(sentences(text, { lang })).toHaveLength(count);
	});

	it.each([
		["es", "initials", "Lo dijo J. L. Borges en Ginebra. Nadie le creyó entonces."],
		["es", "Don as D.", "Lo leyó D. Quijote con mucho cuidado. Nadie le creyó entonces."],
		["es", "s. before a roman century", "En el s. XIX la novela cambió de forma. Luego vino otra cosa."],
		["es", "t. before a roman volume", "Véase el t. II de las obras completas. Allí está todo."],
		["es", "p. before a page number", "Véase la p. 14 del libro citado. Allí está todo."],
		["en", "n. before a note number", "See n. 3 for the details of the case. The rest follows."],
		["fr", "M. for Monsieur and cf. p.", "M. Dupont cite Genette (cf. p. 12) sans le discuter. Il ajoute une note."],
	] as const)("keeps %s abbreviations whole: %s", (lang, _name, text) => {
		expect(sentences(text, { lang })).toHaveLength(2);
	});

	it.each([
		["a closing bracket typed after a space", "This is common in the literature. ) To assume otherwise is naive.", ["This is common in the literature. ) ", "To assume otherwise is naive."]],
		["a parenthesis closed after a spaced period", "The claim is weak (see above . ) The next one is stronger.", ["The claim is weak (see above . ) ", "The next one is stronger."]],
		["a period typed after a space", "The claim is weak . The next one is stronger.", ["The claim is weak . ", "The next one is stronger."]],
	] as const)("ends the sentence at %s", (_name, text, expected) => {
		expect(sentences(text, { lang: "en" })).toEqual(expected);
	});

	it("keeps a stray closer with its sentence when a lower-case word follows", () => {
		expect(sentences("This is common in the literature. ) and so it goes on.", { lang: "en" })).toHaveLength(1);
	});
});

describe("segmentSentences: dialogue and line breaks", () => {
	const dialogue = "Me miró en silencio largo rato. —Sí, ya lo sé todo. —Entonces vete de aquí.";

	it("does not split before a dialogue dash when splitDialogue is off", () => {
		expect(sentences(dialogue)).toHaveLength(1);
	});

	it("splits before a dialogue dash after sentence-final punctuation when on", () => {
		expect(sentences(dialogue, { splitDialogue: true })).toEqual([
			"Me miró en silencio largo rato. ",
			"—Sí, ya lo sé todo. ",
			"—Entonces vete de aquí.",
		]);
	});

	it("keeps a lower-case dialogue tag with its line", () => {
		expect(sentences("—¿Vienes conmigo esta noche? —preguntó ella en voz baja.", { splitDialogue: true })).toHaveLength(1);
	});

	it("treats a newline as a space in 'space' mode", () => {
		expect(sentences("La lectura, decía,\nes una forma de traducción.")).toHaveLength(1);
		expect(sentences("Termina aquí la frase.\nOtra frase empieza luego.")).toHaveLength(2);
	});

	it("ends a sentence at every newline in 'boundary' mode", () => {
		const verse = "The gulls went over and the water stayed,\nthe boat came home without the man who rowed,";
		expect(sentences(verse, { lineBreaks: "space", lang: "en" })).toHaveLength(1);
		expect(sentences(verse, { lineBreaks: "boundary", lang: "en" })).toEqual([
			"The gulls went over and the water stayed,\n",
			"the boat came home without the man who rowed,",
		]);
	});

	it("folds a blank quote line into the line before it", () => {
		const quote = parseNote("> «Leer es traducir, y nada más.»\n>\n> — Elena Varela, *Los espejos*", { textStartHeading: "", skipHeadings: [] });
		const body = quote.blocks[0]?.body ?? "";
		expect(sentences(body, { lineBreaks: "boundary" })).toEqual(["«Leer es traducir, y nada más.»\n\n", "— Elena Varela, Los espejos"]);
	});
});

describe("segmentSentences: ranges", () => {
	it.each(["es_ES", "not a tag!"])("accepts the language code %j without throwing", (lang) => {
		expect(sentences("Primera frase aquí. Segunda frase allá.", { lang })).toEqual(["Primera frase aquí. ", "Segunda frase allá."]);
	});

	it("returns contiguous ranges that cover the text, each later one starting visibly", () => {
		const projection = projectMarkdown("  Primera frase del texto.   Segunda frase aquí.\n\nTercera frase al final.  ");
		const ranges = segmentSentences(projection, rules({ lineBreaks: "boundary" }));
		expect(ranges[0]?.start).toBe(0);
		expect(ranges[ranges.length - 1]?.end).toBe(projection.text.length);
		for (let k = 1; k < ranges.length; k++) {
			expect(ranges[k]?.start).toBe(ranges[k - 1]?.end);
			expect(projection.text.charAt(ranges[k]?.start ?? 0)).not.toMatch(/\s/);
		}
		expect(ranges).toHaveLength(3);
	});

	it("returns no ranges for text without words", () => {
		expect(segmentSentences(projectMarkdown(" — … "), rules())).toEqual([]);
	});

	it("counts the Quijote and Ormsby sentences as the DESIGN map does", () => {
		const count = (name: string, lang: string): number[] => {
			const body = parseNote(fixture(name), { textStartHeading: "", skipHeadings: [] }).blocks[0]?.body ?? "";
			const projection = projectMarkdown(body);
			return segmentSentences(projection, rules({ lang })).map((r) => wordCount(projection.text.slice(r.start, r.end)));
		};
		expect(count("quijote-es.md", "es")).toEqual([33, 33]);
		expect(count("quijote-en.md", "en")).toEqual([46, 35]);
	});
});

describe("sentenceMarkdown", () => {
	function slices(markdown: string, overrides: Partial<SegmentRules> = {}): string[] {
		const projection = projectMarkdown(markdown);
		return sentenceMarkdown(markdown, projection, segmentSentences(projection, rules(overrides)));
	}

	it("keeps a footnote ref and an inline comment with the preceding sentence", () => {
		const markdown = "Primera frase del párrafo.[^1] Segunda frase con nota. %%p. 2%% Tercera frase al final.";
		const parts = slices(markdown);
		expect(parts).toEqual(["Primera frase del párrafo.[^1] ", "Segunda frase con nota. %%p. 2%% ", "Tercera frase al final."]);
		expect(parts.join("")).toBe(markdown);
	});

	it("cuts the Quijote paragraph after its footnote ref", () => {
		const body = parseNote(fixture("quijote-es.md"), { textStartHeading: "", skipHeadings: [] }).blocks[0]?.body ?? "";
		const parts = slices(body);
		expect(parts).toHaveLength(2);
		expect(parts[0]?.endsWith("galgo corredor.[^1] ")).toBe(true);
		expect(parts[1]?.startsWith("Una olla")).toBe(true);
		expect(parts[1]).toContain("%%p. 2%%");
		expect(parts.join("")).toBe(body);
	});

	it("starts a sentence at its own opening markup", () => {
		expect(slices("Primera frase del texto. *Otra* frase empieza aquí.")).toEqual(["Primera frase del texto. ", "*Otra* frase empieza aquí."]);
		expect(slices("Fin de algo aquí. [[Borges, Jorge Luis|Borges]] escribe mucho.")).toEqual([
			"Fin de algo aquí. ",
			"[[Borges, Jorge Luis|Borges]] escribe mucho.",
		]);
	});

	it("concatenates to the input for every fixture paragraph", () => {
		for (const name of ["combined-h1.md", "combined-gen.md", "combined-h2.md", "english-only.md"]) {
			const structure = parseNote(fixture(name), { textStartHeading: "Text", skipHeadings: [] });
			for (const block of structure.blocks.filter((b) => b.kind === "paragraph" || b.kind === "quote")) {
				const projection = projectMarkdown(block.body);
				const mode = block.kind === "quote" ? "boundary" : "space";
				const parts = sentenceMarkdown(block.body, projection, segmentSentences(projection, rules({ lineBreaks: mode })));
				expect(parts.join("")).toBe(block.body);
			}
		}
	});

	it("returns no slices for no sentences", () => {
		expect(sentenceMarkdown("`x`", projectMarkdown("`x`"), [])).toEqual([]);
	});
});
