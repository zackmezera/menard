import { describe, expect, it } from "vitest";
import { declaredLanguage, guessLanguage, languageFromProperty, languageName, proposeLanguages, sameLanguage } from "../../src/jobs/language";

/** Synthetic prose, about forty words each, written for these tests. */
const SAMPLES: Record<string, string> = {
	en: "The translator does not copy the text; he reads it again in another tongue, and that reading is never the same as the first one. It was in this sense that the essay argued for the version as a form of criticism, which has its own history.",
	es: "El traductor no copia el texto; lo vuelve a leer en otra lengua, y esa lectura nunca es la misma que la primera. En este sentido el ensayo defendía la versión como una forma de crítica, que tiene su propia historia y sus propias reglas.",
	fr: "Le traducteur ne copie pas le texte ; il le relit dans une autre langue, et cette lecture n'est jamais la même que la première. C'est en ce sens que l'essai défendait la version comme une forme de critique, qui a son histoire et ses règles.",
	de: "Der Übersetzer kopiert den Text nicht; er liest ihn in einer anderen Sprache noch einmal, und diese Lektüre ist nie dieselbe wie die erste. In diesem Sinn verteidigte der Essay die Version als eine Form der Kritik, die auch ihre eigene Geschichte hat.",
	it: "Il traduttore non copia il testo; lo rilegge in un'altra lingua, e questa lettura non è mai la stessa della prima. È in questo senso che il saggio difendeva la versione come una forma di critica, che ha anche la sua storia e le sue regole.",
	pt: "O tradutor não copia o texto; ele o lê de novo em outra língua, e essa leitura nunca é a mesma que a primeira. Foi nesse sentido que o ensaio defendia a versão como uma forma de crítica, que tem também a sua história e as suas regras.",
};

describe("languageFromProperty", () => {
	it.each([
		["spanish", "es"],
		["Español", "es"],
		["castellano", "es"],
		["English", "en"],
		["français", "fr"],
		["Deutsch", "de"],
		["italiano", "it"],
		["Português", "pt"],
		["Ancient Greek", "grc"],
		["es", "es"],
		["EN", "en"],
		["pt_BR", "pt-BR"],
		["es-ar", "es-AR"],
	])("maps %s to %s", (value, code) => {
		expect(languageFromProperty(value)).toBe(code);
	});

	it.each([[""], ["  "], ["klingonish"], ["spanish and english"], [42], [null], [undefined]])("gives null for %s", (value) => {
		expect(languageFromProperty(value)).toBeNull();
	});

	it("takes the first entry of a list", () => {
		expect(languageFromProperty(["spanish", "english"])).toBe("es");
	});
});

describe("declaredLanguage", () => {
	it("prefers originalLanguage, then language, then lang", () => {
		expect(declaredLanguage({ language: "fr", originalLanguage: "spanish" })).toBe("es");
		expect(declaredLanguage({ language: "fr", lang: "de" })).toBe("fr");
		expect(declaredLanguage({ originalLanguage: "unknown", lang: "de" })).toBe("de");
		expect(declaredLanguage({ citekey: "x" })).toBeNull();
		expect(declaredLanguage(undefined)).toBeNull();
	});
});

describe("guessLanguage", () => {
	it.each(Object.entries(SAMPLES))("recognizes %s", (lang, text) => {
		expect(guessLanguage(text)).toBe(lang);
	});

	it("recognizes the language of hard-wrapped Markdown with names and numbers", () => {
		const text = `${SAMPLES.en}\nBorges, J. L. (1932). *Discusión*. Buenos Aires: Gleizer, pp. 105–117.`;
		expect(guessLanguage(text)).toBe("en");
	});

	it("makes no guess on short text", () => {
		expect(guessLanguage("The translator does not copy the text.")).toBeNull();
	});

	it("makes no guess on text without stopwords", () => {
		expect(guessLanguage(Array.from({ length: 40 }, (_, i) => `Zxq${String.fromCharCode(97 + (i % 26))}`).join(" "))).toBeNull();
	});
});

describe("proposeLanguages", () => {
	const defaults = { source: "es", target: "en" };

	it("uses the defaults without a declared language", () => {
		expect(proposeLanguages(null, defaults)).toEqual(defaults);
	});

	it("uses the declared language as the source", () => {
		expect(proposeLanguages("fr", defaults)).toEqual({ source: "fr", target: "en" });
	});

	it("proposes the default source as the target when the note is already in the default target language", () => {
		expect(proposeLanguages("en", defaults)).toEqual({ source: "en", target: "es" });
		expect(proposeLanguages("en-GB", defaults)).toEqual({ source: "en-GB", target: "es" });
	});
});

describe("sameLanguage and languageName", () => {
	it("compares primary subtags", () => {
		expect(sameLanguage("en", "en-GB")).toBe(true);
		expect(sameLanguage("ES", "es")).toBe(true);
		expect(sameLanguage("es", "pt")).toBe(false);
		expect(sameLanguage("", "")).toBe(false);
	});

	it("names languages in English", () => {
		expect(languageName("es")).toBe("Spanish");
		expect(languageName("en")).toBe("English");
	});
});
