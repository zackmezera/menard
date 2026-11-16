import { describe, expect, it } from "vitest";
import { isMenardError } from "../../src/errors";
import { placeholdersIn, protect, restore, wikilinksIn } from "../../src/llm/protect";

/** A paragraph of synthetic academic Spanish with every inline token class. */
const PARAGRAPH = [
	"Según el Sr. Pérez (cf. pp. 23-25), [[Borges, Jorge Luis|Borges]] leyó a Poe en Ginebra.[^1] %%p. 204%%",
	"En «Pierre Menard, autor del *Quijote*» el narrador cita la fórmula `verdad, cuya madre es la historia`",
	"y la compara con $x^2$ y $$\\sum_i a_i$$; véase ![[mapa-ginebra.png]] y ![grabado](img/grabado.jpg).",
	"La edición de <span class=\"sc\">Sur</span> (1939) circuló poco,[^en-3] según la [nota del editor](https://example.org/nota_(1) \"Nota\")",
	"y <https://example.org/archivo>; el texto dice: “la historia, madre de la verdad”.[^1]",
].join("\n");

describe("protect", () => {
	it("round-trips every token class", () => {
		const { text, tokens } = protect(PARAGRAPH);
		expect(restore(text, tokens)).toBe(PARAGRAPH);
	});

	it("replaces each token class with its placeholder", () => {
		const { text } = protect(PARAGRAPH);
		expect(text).toContain("Ginebra.⟦^1⟧ ⟦C1⟧");
		expect(text).toContain("la fórmula ⟦V1⟧");
		expect(text).toContain("con ⟦V2⟧ y ⟦V3⟧; véase ⟦V4⟧ y ⟦V5⟧.");
		expect(text).toContain("La edición de ⟦V6⟧Sur⟦V7⟧ (1939) circuló poco,⟦^en-3⟧");
		expect(text).toContain("[nota del editor](⟦U1⟧)");
		expect(text).toContain("y ⟦V8⟧; el texto dice: “la historia, madre de la verdad”.⟦^1⟧");
		expect(text).toContain("[[Borges, Jorge Luis|Borges]]");
		expect(text).not.toContain("\n");
	});

	it("protects an inline %%p. 204%% page marker as a comment", () => {
		const input = "La segunda parte empieza aquí. %%p. 204%% Pero el narrador duda.";
		const { text, tokens } = protect(input);
		expect(text).toBe("La segunda parte empieza aquí. ⟦C1⟧ Pero el narrador duda.");
		expect(tokens).toEqual([{ placeholder: "⟦C1⟧", original: "%%p. 204%%" }]);
		expect(restore(text, tokens)).toBe(input);
	});

	it("issues one token per footnote label, however often it occurs", () => {
		const { text, tokens } = protect("Uno.[^3] Dos.[^3] Tres.[^gen-4]");
		expect(text).toBe("Uno.⟦^3⟧ Dos.⟦^3⟧ Tres.⟦^gen-4⟧");
		expect(tokens.map((t) => t.placeholder)).toEqual(["⟦^3⟧", "⟦^gen-4⟧"]);
	});

	it("keeps the link label translatable and protects only the URL", () => {
		const { text, tokens } = protect("Véase [el *ensayo* de 1932](https://example.org/ensayo).");
		expect(text).toBe("Véase [el *ensayo* de 1932](⟦U1⟧).");
		expect(tokens).toEqual([{ placeholder: "⟦U1⟧", original: "https://example.org/ensayo" }]);
	});

	it("leaves wikilinks and their contents alone", () => {
		const input = "Cf. [[@borgesversiones1932#^p3|«Las versiones homéricas»]] y [[Ruiz, A.]].";
		expect(protect(input).text).toBe(input);
	});

	it("does not treat escaped or prose dollar signs as math", () => {
		const input = "Costó US$ 500 en 1939 y \\$20 en 1950; $5 y $6 más tarde.";
		const { text, tokens } = protect(input);
		expect(text).toBe(input);
		expect(tokens).toEqual([]);
	});

	it("does not look inside inline code for other tokens", () => {
		const { text, tokens } = protect("El marcador ``%%p. 1%% [^2]`` es literal.");
		expect(text).toBe("El marcador ⟦V1⟧ es literal.");
		expect(tokens[0]?.original).toBe("``%%p. 1%% [^2]``");
	});

	it("turns quote line breaks into ⟦BR⟧ and blank quote lines into ⟦P⟧", () => {
		const verse = "Yo, que tantos hombres he sido,\nno he sido nunca aquel\n\nen cuyo abrazo desfallecía Matilde Urbach.";
		const { text, tokens } = protect(verse);
		expect(text).toBe("Yo, que tantos hombres he sido,⟦BR⟧no he sido nunca aquel⟦P⟧en cuyo abrazo desfallecía Matilde Urbach.");
		expect(restore(text, tokens)).toBe(verse);
	});

	it("round-trips runs of blank lines", () => {
		const input = "a\n\n\nb\n\n\n\nc";
		const { text, tokens } = protect(input);
		expect(text).toBe("a⟦P⟧⟦BR⟧b⟦P⟧⟦P⟧c");
		expect(restore(text, tokens)).toBe(input);
	});

	it("protects angle-bracket link targets and single-quoted titles", () => {
		const input = "Véase [la carta](<Cartas de 1939.md>) y [el sitio](https://ejemplo.org 'Archivo').";
		const { text, tokens } = protect(input);
		expect(text).toBe("Véase [la carta](⟦U1⟧) y [el sitio](⟦U2⟧).");
		expect(restore(text, tokens)).toBe(input);
	});

	it("protects the reference of a full reference link and keeps its label translatable (#30)", () => {
		const input = "Véase [el ensayo de 1932][borges] y [la reseña] [sur].";
		const { text, tokens } = protect(input);
		expect(text).toBe("Véase [el ensayo de 1932][⟦U1⟧] y [la reseña] [sur].");
		expect(tokens).toEqual([{ placeholder: "⟦U1⟧", original: "borges" }]);
		expect(restore(text, tokens)).toBe(input);
	});

	it("keeps a collapsed reference link whole, since its label is the reference", () => {
		const { text, tokens } = protect("Según [Sur][], la revista.");
		expect(text).toBe("Según ⟦V1⟧, la revista.");
		expect(tokens[0]?.original).toBe("[Sur][]");
	});

	it("keeps reference definitions whole", () => {
		const input = "[borges]: https://example.org/versiones \"Las versiones\"\n[sur]: <https://example.org/sur>";
		const { text, tokens } = protect(input, { lineBreaks: "keep" });
		expect(text).toBe("⟦V1⟧\n⟦V2⟧");
		expect(restore(text, tokens)).toBe(input);
	});

	it("does not mistake a footnote after a link label for a reference", () => {
		const { text } = protect("La [nota](https://example.org/n)[^2] y *Quijote*][^3]");
		expect(text).toBe("La [nota](⟦U1⟧)⟦^2⟧ y *Quijote*]⟦^3⟧");
	});

	it.each([
		["Disponible en https://example.org/archivo/1932.", "Disponible en ⟦U1⟧.", "https://example.org/archivo/1932"],
		["(véase https://example.org/a_(b)), y luego", "(véase ⟦U1⟧), y luego", "https://example.org/a_(b)"],
		["«www.example.org/sur»; fin", "«⟦U1⟧»; fin", "www.example.org/sur"],
		["Escribir a mailto:editor@example.org!", "Escribir a ⟦U1⟧!", "mailto:editor@example.org"],
	])("protects a bare URL without its trailing punctuation: %s", (input, expected, url) => {
		const { text, tokens } = protect(input);
		expect(text).toBe(expected);
		expect(tokens).toEqual([{ placeholder: "⟦U1⟧", original: url }]);
		expect(restore(text, tokens)).toBe(input);
	});

	it("does not treat an e-mail address or a word ending in www as a URL", () => {
		const input = "Escriba a editor@www.example.org o al señor Awww.";
		expect(protect(input).text).toBe(input);
	});

	it("turns a backslash hard break into ⟦BR⟧ and keeps the backslash", () => {
		const verse = "Primer verso,\\\nsegundo verso.";
		const { text, tokens } = protect(verse);
		expect(text).toBe("Primer verso,\\⟦BR⟧segundo verso.");
		expect(text).not.toContain("\n");
		expect(restore(text, tokens)).toBe(verse);
	});

	it("keeps soft line breaks of a paragraph when asked", () => {
		const input = "Una línea cortada\na mano.[^2]";
		const { text, tokens } = protect(input, { lineBreaks: "keep" });
		expect(text).toBe("Una línea cortada\na mano.⟦^2⟧");
		expect(restore(text, tokens)).toBe(input);
	});

	it.each(["El signo ⟦ aparece aquí.", "Y aquí ⟧ también."])("refuses reserved characters: %s", (input) => {
		let caught: unknown;
		try {
			protect(input);
		} catch (error) {
			caught = error;
		}
		expect(isMenardError(caught, "reserved-character")).toBe(true);
	});
});

describe("restore", () => {
	it("restores placeholders the model moved and leaves unknown ones alone", () => {
		const { tokens } = protect("Borges[^1] y `Menard`.");
		expect(restore("`x` ⟦V1⟧ and Borges⟦^1⟧ ⟦V9⟧", tokens)).toBe("`x` `Menard` and Borges[^1] ⟦V9⟧");
	});
});

describe("placeholdersIn and wikilinksIn", () => {
	it("lists placeholders in order, including invented ones", () => {
		expect(placeholdersIn("a⟦^1⟧ b ⟦C1⟧⟦BR⟧ c ⟦X9⟧ ⟦^1⟧")).toEqual(["⟦^1⟧", "⟦C1⟧", "⟦BR⟧", "⟦X9⟧", "⟦^1⟧"]);
	});

	it("lists wikilinks in order and skips embeds", () => {
		expect(wikilinksIn("[[a]] ![[b.png]] [[c|d]] [[a]]")).toEqual(["[[a]]", "[[c|d]]", "[[a]]"]);
	});
});
