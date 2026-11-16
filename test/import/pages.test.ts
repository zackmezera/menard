import { describe, expect, it } from "vitest";
import { placePageMarkers, reduce } from "../../src/import/pages";
import type { PageOpening } from "../../src/import/pages";
import { applyInserts, isInsertOnly } from "../../src/text/edits";

/** An invented chapter: distinct sentences so every page opening is unique. */
const SENTENCES = [
	"La biblioteca abría temprano y el portero saludaba a cada lector con una inclinación solemne.",
	"Nadie sabía cuántos volúmenes guardaban los sótanos, aunque todos repetían una cifra distinta.",
	"Una mañana apareció un catálogo escrito a mano, con letras diminutas y márgenes manchados.",
	"El catálogo describía libros que nadie había visto jamás en los estantes de la casa.",
	"Los bibliotecarios discutieron durante semanas sobre la procedencia de aquel cuaderno extraño.",
	"Finalmente decidieron copiarlo entero, palabra por palabra, para conservarlo sin tocar el original.",
	"La copia resultó más larga que el original, porque cada copista agregaba notas al pie.",
	"Con el tiempo las notas crecieron hasta formar un segundo catálogo, más extenso que el primero.",
];

const CHAPTER = [
	"---",
	"book: \"[[@x]]\"",
	"---",
	"# Capítulo de prueba",
	"",
	`${SENTENCES[0]} ${SENTENCES[1]} ${SENTENCES[2]}`,
	"",
	"## Segunda parte",
	"",
	`${SENTENCES[3]} ${SENTENCES[4]}[^1] ${SENTENCES[5]}`,
	"",
	`${SENTENCES[6]} ${SENTENCES[7]}`,
	"",
	"[^1]: Una nota que no forma parte del cuerpo.",
	"",
].join("\n");

/** OCR damage: spaces inside words, lost accents, a misread letter or two, a broken hyphen. */
function garble(text: string): string {
	return text
		.replace(/una/g, "u n a")
		.replace(/mente/g, "m ente")
		.replace(/á/g, "a")
		.replace(/ó/g, "o")
		.replace(/catálogo/g, "cata- logo")
		.replace(/m/g, (m, i: number) => (i % 37 === 0 ? "rn" : m));
}

function opening(label: string, pageText: string): PageOpening {
	const letters = reduce(pageText);
	return { label, opening: letters.slice(0, 60), letters: letters.length };
}

/** The text that starts at an insert, after the marker. */
function after(text: string, at: number, length = 25): string {
	return text.slice(at, at + length);
}

describe("placePageMarkers", () => {
	it("finds page openings through OCR damage and inserts at word starts", () => {
		const pages = [
			opening("12", garble(`Capítulo de prueba ${SENTENCES[0]}`)),
			opening("13", garble(`${SENTENCES[2]} ${SENTENCES[3]}`)),
			opening("14", garble(`${SENTENCES[6]}`)),
		];
		const result = placePageMarkers(CHAPTER, pages);
		expect(result.skipped).toEqual([]);
		expect(result.placed.map((p) => p.label)).toEqual(["12", "13", "14"]);
		const [heading, middle, para] = result.inserts;
		expect(heading).toEqual({ at: CHAPTER.indexOf("# Capítulo"), text: "%%p. 12%%\n\n" });
		expect(middle!.text).toBe("%%p. 13%% ");
		expect(after(CHAPTER, middle!.at)).toBe("Una mañana apareció un ca");
		expect(after(CHAPTER, para!.at)).toBe("La copia resultó más larg");
		const written = applyInserts(CHAPTER, result.inserts);
		expect(isInsertOnly(CHAPTER, written, result.inserts)).toBe(true);
		expect(written).toContain("márgenes manchados.");
	});

	it("snaps a page that starts mid-word to the nearer word boundary", () => {
		// Printed pages starting with the tail of "bibliotecarios": most of the word, then only its end.
		const long = placePageMarkers(CHAPTER, [opening("20", garble("liotecarios discutieron durante semanas sobre la procedencia"))]).inserts[0];
		expect(after(CHAPTER, long!.at)).toBe("bibliotecarios discutiero");
		const short = placePageMarkers(CHAPTER, [opening("20", garble("carios discutieron durante semanas sobre la procedencia de aquel"))]).inserts[0];
		expect(after(CHAPTER, short!.at)).toBe("discutieron durante seman");
	});

	it("skips pages from elsewhere in the book and keeps the order", () => {
		const pages = [
			opening("30", "Este texto pertenece a otro capítulo y no aparece en la nota que estamos marcando ahora."),
			opening("31", SENTENCES[5]!),
			opening("32", SENTENCES[1]!), // earlier than page 31: cannot be placed after it
		];
		const result = placePageMarkers(CHAPTER, pages);
		expect(result.placed.map((p) => p.label)).toEqual(["31"]);
		expect(result.skipped.map((s) => s.label)).toEqual(["30", "32"]);
		expect(result.skipped[0]!.reason).toMatch(/no confident match/);
	});

	it("never moves or duplicates an existing marker and searches between markers", () => {
		const marked = CHAPTER.replace("Finalmente", "%%p. 16%% Finalmente");
		const pages = [opening("15", SENTENCES[3]!), opening("16", SENTENCES[5]!), opening("17", SENTENCES[7]!)];
		const result = placePageMarkers(marked, pages);
		expect(result.skipped).toEqual([{ label: "16", reason: "already marked" }]);
		expect(result.placed.map((p) => p.label)).toEqual(["15", "17"]);
		expect(result.inserts[0]!.at).toBeLessThan(marked.indexOf("%%p. 16%%"));
		expect(result.inserts[1]!.at).toBeGreaterThan(marked.indexOf("%%p. 16%%"));
	});

	it("does not match inside footnote definitions or frontmatter", () => {
		const result = placePageMarkers(CHAPTER, [opening("40", "Una nota que no forma parte del cuerpo de este texto")]);
		expect(result.placed).toEqual([]);
	});

	it("skips a page with too little text", () => {
		expect(placePageMarkers(CHAPTER, [opening("9", "iv")]).skipped).toEqual([{ label: "9", reason: "too little text on the page" }]);
	});

	it("reduces text to bare letters", () => {
		expect(reduce("C uriosam ente, ¡déjà-vu! 1999 ﬁn")).toBe("curiosamentedejavufin");
	});
});
