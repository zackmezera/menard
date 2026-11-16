import { describe, expect, it } from "vitest";
import { projectMarkdown } from "../../src/text/inline";

describe("projectMarkdown", () => {
	it.each([
		// Wikilinks
		["wikilink", "Según [[Borges, Jorge Luis]] leyó.", "Según Borges, Jorge Luis leyó."],
		["aliased wikilink", "Según [[Borges, Jorge Luis|Borges]] leyó.", "Según Borges leyó."],
		["heading wikilink", "Véase [[@ruiz2002#Introducción]].", "Véase @ruiz2002 > Introducción."],
		["nested heading wikilink", "[[nota#uno#dos]]", "nota > uno > dos"],
		["block wikilink", "[[@ruiz2002#^p12]]", "@ruiz2002 > ^p12"],
		["same-note heading wikilink", "[[#Notas]]", "Notas"],
		["aliased heading wikilink", "[[@ruiz2002#^p12|el párrafo]]", "el párrafo"],
		// Markdown links
		["md link", "Ver [el artículo](https://example.org/a_(b)) completo.", "Ver el artículo completo."],
		["md link with title", '[texto](url "título")', "texto"],
		["md link with angle destination", "[texto](<una url con espacios>)", "texto"],
		["md link with emphasis inside", "[*Ficciones*](x) de 1944", "Ficciones de 1944"],
		["bracket without destination", "[sic] y [1]", "[sic] y [1]"],
		["autolink", "<https://example.org/x>", "https://example.org/x"],
		["bare URL", "https://example.org/a_b_c", "https://example.org/a_b_c"],
		// Emphasis and highlight
		["italics", "una *lectura* atenta", "una lectura atenta"],
		["bold", "**La ética del estilo**", "La ética del estilo"],
		["bold italics", "***muy***", "muy"],
		["underscore emphasis", "_Discusión_ (1932)", "Discusión (1932)"],
		["intraword underscore", "snake_case_name", "snake_case_name"],
		["intraword star", "a*b*c", "abc"],
		["spaced star", "5 * 3", "5 * 3"],
		["strikethrough", "~~borrado~~ visible", "borrado visible"],
		["highlight", "==subrayado== aquí", "subrayado aquí"],
		["spaced equals", "a == b", "a == b"],
		["unmatched star between digits", "2*3 = 6", "2*3 = 6"],
		["unmatched intraword star", "a*b y c", "a*b y c"],
		["unmatched intraword equals", "x==y", "x==y"],
		["stray closing star", "fin* aquí", "fin* aquí"],
		["unbalanced bold keeps the extra star", "**negrita*", "*negrita"],
		["star inside highlight", "==a*b== c", "a*b c"],
		["nested emphasis", "*a **b** c*", "a b c"],
		// Escapes
		["escaped star", "\\*no es énfasis\\*", "*no es énfasis*"],
		["escaped bracket", "\\[^1\\]", "[^1]"],
		["escaped percent", "50\\%", "50%"],
		["backslash before letter", "C:\\temp", "C:\\temp"],
		["backslash hard break", "uno\\\ndos", "uno\ndos"],
		// Footnotes
		["footnote ref", "corredor.[^1] Una olla", "corredor. Una olla"],
		["labelled footnote ref", "texto[^en-12] sigue", "texto sigue"],
		["inline footnote", "texto^[una nota *breve*] sigue", "texto sigue"],
		// Comments
		["inline comment", "de %%p. 2%% añadidura", "de  añadidura"],
		["unclosed comment", "visible %%oculto hasta el final", "visible "],
		["multi-line inline comment", "uno %%a\nb%% dos", "uno  dos"],
		// Code and math
		["inline code", "el botón `BUTTON[x]` aquí", "el botón  aquí"],
		["double backtick code", "``a ` b`` fin", " fin"],
		["unmatched backtick", "un ` suelto", "un ` suelto"],
		["inline math", "si $x^2$ crece", "si  crece"],
		["dollar amounts", "cuesta $5 y $6", "cuesta $5 y $6"],
		["display math inline", "antes $$a+b$$ después", "antes  después"],
		// Embeds
		["embed", "![[Text.base]] tras", " tras"],
		["image", "![alt *text*](img.png) tras", " tras"],
		["exclamation", "¡Basta! dijo", "¡Basta! dijo"],
		// HTML
		["html span", 't<span style="color:red">ext</span>o', "texto"],
		["html br", "uno<br>dos<br/>tres", "uno\ndos\ntres"],
		["html comment", "a<!-- nota -->b", "ab"],
		["less than", "a < b y c<d", "a < b y c<d"],
		["Latin-1 entities", "caf&eacute; &Ntilde;u&ntilde;o 1.&ordm; ping&uuml;ino", "café Ñuño 1.º pingüino"],
		["entity names are case-sensitive", "&NBSP; &Eacute; &AMP;", "&NBSP; É &"],
		["entities", "&laquo;no&raquo; &amp; &#233; &#xE9; &nbsp; &bogus;", "«no» & é é \u00a0 &bogus;"],
		// Lines
		["soft line break", "primera línea\nsegunda", "primera línea\nsegunda"],
		["quotes kept", "«Basta», dijo. “Bien”.", "«Basta», dijo. “Bien”."],
	])("%s", (_name, input, expected) => {
		expect(projectMarkdown(input).text).toBe(expected);
	});

	it("normalizes to NFC and maps composed characters to their base", () => {
		const nfd = "Pe\u0301rez *leyo\u0301*";
		const projection = projectMarkdown(nfd);
		expect(projection.text).toBe("Pérez leyó");
		expect(projection.text).toBe(projection.text.normalize("NFC"));
		expect(projection.toInput[1]).toBe(1);
		expect(projection.toInput[2]).toBe(3);
		expect(projection.toInput[9]).toBe(11);
	});

	it("has one input index per output character, pointing at the character it came from", () => {
		const markdown = "Según [[Borges, Jorge Luis|Borges]], *el* [libro](u)[^1] %%x%% fin\n\\*.";
		const projection = projectMarkdown(markdown);
		expect(projection.toInput).toHaveLength(projection.text.length);
		for (let i = 0; i < projection.text.length; i++) {
			const ch = projection.text.charAt(i);
			expect(markdown.charAt(projection.toInput[i] ?? -1)).toBe(ch);
		}
		const increasing = Array.from(projection.toInput).every((v, i, a) => i === 0 || v > (a[i - 1] ?? -1));
		expect(increasing).toBe(true);
	});

	it("maps the ' > ' of a heading link to the '#'", () => {
		const projection = projectMarkdown("[[a#h]]");
		expect(projection.text).toBe("a > h");
		expect(Array.from(projection.toInput)).toEqual([2, 3, 3, 3, 4]);
	});

	it("returns an empty projection for markup-only input", () => {
		const projection = projectMarkdown("`BUTTON[read-today]` ![[Text.base]] %%p. 3%%");
		expect(projection.text.trim()).toBe("");
	});
});
