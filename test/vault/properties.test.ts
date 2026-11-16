import { describe, expect, it } from "vitest";
import { parseNewNoteProperties, translationPath, wikilinkValue } from "../../src/vault/properties";

describe("parseNewNoteProperties", () => {
	it("reads key: value lines", () => {
		expect(parseNewNoteProperties("collection: translation\ntextStatus: draft")).toEqual({
			collection: "translation",
			textStatus: "draft",
		});
	});

	it("skips blank and malformed lines", () => {
		const setting = ["", "collection: translation", "   ", "esto no es una propiedad", ": sin clave", "1x: inválida", "vacía:"].join(
			"\n",
		);
		expect(parseNewNoteProperties(setting)).toEqual({ collection: "translation" });
	});

	it("trims, accepts CRLF and keeps colons inside values", () => {
		expect(parseNewNoteProperties("  note : Ver cap. 3: «El acercamiento»  \r\nlang: es")).toEqual({
			note: "Ver cap. 3: «El acercamiento»",
			lang: "es",
		});
	});

	it("removes one pair of surrounding quotes", () => {
		expect(parseNewNoteProperties(`course: "[[SPAN 194]]"\nlabel: 'traducción'`)).toEqual({
			course: "[[SPAN 194]]",
			label: "traducción",
		});
	});

	it("never lets the setting override Menard's pair keys", () => {
		expect(parseNewNoteProperties("source: https://example.org\ntranslation: x\nsourceLanguage: fr\ncollection: translation")).toEqual(
			{ collection: "translation" },
		);
	});

	it("lets a later line win", () => {
		expect(parseNewNoteProperties("collection: a\ncollection: b")).toEqual({ collection: "b" });
	});
});

describe("wikilinkValue", () => {
	it("wraps the linktext in double brackets", () => {
		expect(wikilinkValue("@ruizalmotasim (EN)")).toBe("[[@ruizalmotasim (EN)]]");
		expect(wikilinkValue("Collections/Texts/@ruizalmotasim")).toBe("[[Collections/Texts/@ruizalmotasim]]");
	});
});

describe("translationPath", () => {
	it("puts the translation beside its source with an upper-case language suffix", () => {
		expect(translationPath("Collections/Texts/@ruizalmotasim.md", "en")).toBe("Collections/Texts/@ruizalmotasim (EN).md");
	});

	it("works at the vault root", () => {
		expect(translationPath("@borgesversiones1932.md", "en")).toBe("@borgesversiones1932 (EN).md");
	});

	it("keeps region subtags and dots in the basename", () => {
		expect(translationPath("Textos/Giordano, resistencia v.2.md", "pt-br")).toBe("Textos/Giordano, resistencia v.2 (PT-BR).md");
	});

	it("normalizes the result", () => {
		expect(translationPath("/Collections//Texts/@giordanoresistencia.md", " en ")).toBe(
			"Collections/Texts/@giordanoresistencia (EN).md",
		);
		expect(translationPath("Textos/Café.md", "en")).toBe("Textos/Café (EN).md");
	});
});
