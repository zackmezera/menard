import { describe, expect, it } from "vitest";
import { isMetadataLine, isSentenceUnit, parseNote, textUnits } from "../../src/text/blocks";
import type { Block, ParseOptions, UnitKind } from "../../src/types";

const ALL_TEXT: ParseOptions = { textStartHeading: "", skipHeadings: [] };

function parse(lines: readonly string[], options: ParseOptions = ALL_TEXT) {
	return parseNote(lines.join("\n"), options);
}

function only(lines: readonly string[]): Block {
	const { blocks } = parse(lines);
	expect(blocks).toHaveLength(1);
	return blocks[0] as Block;
}

describe("parseNote: frontmatter and EOL", () => {
	it("records frontmatter lines including both fences and starts blocks after it", () => {
		const s = parse(["---", "citekey: x", "---", "Un párrafo."]);
		expect(s.frontmatter).toEqual({ start: 0, end: 3 });
		expect(s.blocks.map((b) => b.lines)).toEqual([{ start: 3, end: 4 }]);
		expect(s.eol).toBe("\n");
		expect(s.lineCount).toBe(4);
	});

	it("recognizes frontmatter after a byte-order mark", () => {
		const s = parseNote("\uFEFF---\ncitekey: x\n---\nUn párrafo.", ALL_TEXT);
		expect(s.frontmatter).toEqual({ start: 0, end: 3 });
		expect(s.blocks.map((b) => b.kind)).toEqual(["paragraph"]);
	});

	it("ignores an unclosed frontmatter fence", () => {
		const s = parse(["---", "citekey: x"]);
		expect(s.frontmatter).toBeNull();
	});

	it("detects CRLF, keeps it in raw and uses LF in body", () => {
		const s = parseNote("---\r\na: 1\r\n---\r\nPrimera línea\r\nsegunda línea ^p3\r\n\r\n> cita\r\n> otra\r\n", ALL_TEXT);
		expect(s.eol).toBe("\r\n");
		expect(s.frontmatter).toEqual({ start: 0, end: 3 });
		const [para, quote] = s.blocks;
		expect(para?.raw).toBe("Primera línea\r\nsegunda línea");
		expect(para?.body).toBe("Primera línea\nsegunda línea");
		expect(para?.id).toBe("p3");
		expect(quote?.raw).toBe("> cita\r\n> otra");
		expect(quote?.body).toBe("cita\notra");
	});
});

describe("parseNote: block kinds", () => {
	it("keeps hard-wrapped lines in one paragraph", () => {
		const b = only(["La traducción, decía,", "es una forma de lectura."]);
		expect(b.kind).toBe("paragraph");
		expect(b.lines).toEqual({ start: 0, end: 2 });
		expect(b.body).toBe("La traducción, decía,\nes una forma de lectura.");
	});

	it("keeps blank '>' lines inside a quote and strips the prefix", () => {
		const b = only(["> «Leer es traducir.»", ">", "> — Elena Varela, *Los espejos*"]);
		expect(b.kind).toBe("quote");
		expect(b.body).toBe("«Leer es traducir.»\n\n— Elena Varela, *Los espejos*");
	});

	it("parses a callout with fold marker and title, body without the header", () => {
		const b = only(["> [!abstract]- Resumen del artículo", "> Este artículo examina la idea.", "> Y propone otra."]);
		expect(b.kind).toBe("callout");
		expect(b.calloutType).toBe("abstract");
		expect(b.calloutTitle).toBe("Resumen del artículo");
		expect(b.body).toBe("Este artículo examina la idea.\nY propone otra.");
	});

	it("parses a one-line callout with an empty body", () => {
		const b = only(["> [!note] Traducción de trabajo."]);
		expect(b.kind).toBe("callout");
		expect(b.calloutTitle).toBe("Traducción de trabajo.");
		expect(b.body).toBe("");
	});

	it("takes the whole list, including indented continuation and loose items", () => {
		const s = parse(["- Morales, Inés. *Otra vez la lectura*.", "  Buenos Aires, 2015.", "", "- Pérez, Julio.", "  1. Primera edición", "", "Después."]);
		expect(s.blocks.map((b) => [b.kind, b.lines.start, b.lines.end])).toEqual([
			["list", 0, 5],
			["paragraph", 6, 7],
		]);
	});

	it("parses a table from a header row and a delimiter row", () => {
		const s = parse(["| Año | Obra |", "| --- | :---: |", "| 1932 | *Discusión* |", "", "Texto."]);
		expect(s.blocks.map((b) => [b.kind, b.lines.end])).toEqual([
			["table", 3],
			["paragraph", 5],
		]);
	});

	it("does not take a line with a pipe but no delimiter row as a table", () => {
		expect(only(["uno | dos", "tres"]).kind).toBe("paragraph");
	});

	it("parses a footnote with 4-space and tab continuation, blank lines and a nested quote", () => {
		const b = only([
			"[^en-3]: Primer párrafo de la nota,",
			"que sigue en una línea perezosa.",
			"",
			"    Segundo párrafo.",
			"\tTercero, con tabulador.",
			"",
			"    > Verso uno,",
			"    > verso dos.",
		]);
		expect(b.kind).toBe("footnote");
		expect(b.footnoteLabel).toBe("en-3");
		expect(b.body).toBe(
			"Primer párrafo de la nota,\nque sigue en una línea perezosa.\n\nSegundo párrafo.\nTercero, con tabulador.\n\n> Verso uno,\n> verso dos.",
		);
	});

	it("ends a footnote at an unindented line after a blank", () => {
		const s = parse(["[^1]: Nota.", "", "Párrafo."]);
		expect(s.blocks.map((b) => b.kind)).toEqual(["footnote", "paragraph"]);
	});

	it("parses ATX headings and strips closing #s", () => {
		const s = parse(["## Introducción ##", "", "### C# y otros", "", "#etiqueta no es encabezado"]);
		expect(s.blocks.map((b) => [b.kind, b.headingLevel, b.body])).toEqual([
			["heading", 2, "Introducción"],
			["heading", 3, "C# y otros"],
			["paragraph", undefined, "#etiqueta no es encabezado"],
		]);
	});

	it("parses setext headings", () => {
		const s = parse(["Título", "===", "", "Subtítulo", "---"]);
		expect(s.blocks.map((b) => [b.kind, b.headingLevel, b.body])).toEqual([
			["heading", 1, "Título"],
			["heading", 2, "Subtítulo"],
		]);
	});

	it("lets a heading end a paragraph without a blank line", () => {
		const s = parse(["## A Difficulty of Method", "*Tomás Suárez — Universidad del Litoral*", "Texto."]);
		expect(s.blocks.map((b) => [b.kind, b.lines.start, b.lines.end])).toEqual([
			["heading", 0, 1],
			["paragraph", 1, 3],
		]);
	});

	it.each([
		["a backtick fence", ["```js", "const x = 1;", "", "```"]],
		["a tilde fence", ["~~~", "texto", "~~~"]],
		["a multi-line $$ block", ["$$", "a^2 + b^2", "$$"]],
		["a one-line $$ block", ["$$ e^{i\\pi} = -1 $$"]],
		["an HTML block", ["<div class=\"x\">", "contenido", "</div>"]],
		["an HTML comment", ["<!-- nota", "privada -->"]],
		["an embed-only line", ["![[Text.base]]"]],
		["a thematic break", ["---"]],
		["a starred thematic break", ["* * *"]],
		["a one-line comment block", ["%%p. 204%%"]],
		["a multi-line comment block", ["%%", "nota privada", "%%"]],
		["a zero-word paragraph", ["`BUTTON[read-today]` `BUTTON[copy-passages]`"]],
		["an indented code block", ["    código", "", "    más código"]],
	])("treats %s as verbatim", (_name, lines) => {
		const b = only(lines);
		expect(b.kind).toBe("verbatim");
		expect(b.lines).toEqual({ start: 0, end: lines.length });
		expect(b.raw).toBe(lines.join("\n"));
	});

	it("keeps a paragraph that opens with an inline comment", () => {
		expect(only(["%%p. 204%% El texto sigue aquí."]).kind).toBe("paragraph");
	});

	it("recognizes a whole Menard line, even right after a paragraph", () => {
		const s = parse(["Texto del párrafo. ^p1", "%%menard:1 p1 3.abcd/3.efgh%%", "", "%%menard:1 p2 translate%%"]);
		expect(s.blocks.map((b) => b.kind)).toEqual(["paragraph", "menard", "menard"]);
		expect(s.blocks[1]?.raw).toBe("%%menard:1 p1 3.abcd/3.efgh%%");
	});

	it("hides ids and Menard lines inside code fences", () => {
		const s = parse(["```markdown", "Ejemplo. ^p1", "", "%%menard:1 p1 2.abcd/2.efgh%%", "", "^p9", "```", "", "Fuera. ^p4"]);
		expect(s.blocks.map((b) => b.kind)).toEqual(["verbatim", "paragraph"]);
		expect([...s.usedIds]).toEqual(["p4"]);
	});

	it("leaves an unclosed fence open to the end of the note", () => {
		const s = parse(["```", "%%menard:1 p1 translate%%", "Texto."]);
		expect(s.blocks.map((b) => b.kind)).toEqual(["verbatim"]);
	});
});

describe("parseNote: ids", () => {
	it("reads a trailing id followed by whitespace, so it is never allocated twice", () => {
		const s = parse(["Texto final. ^p1 \t", "", "> Cita. ^p2 "]);
		expect(s.blocks.map((b) => [b.id, b.idStyle, b.body])).toEqual([
			["p1", "trailing", "Texto final."],
			["p2", "trailing", "Cita."],
		]);
		expect([...s.usedIds].sort()).toEqual(["p1", "p2"]);
	});

	it("reads a trailing id on a one-line callout and keeps it out of the title", () => {
		const block = only(["> [!note] Título breve ^c1"]);
		expect([block.kind, block.id, block.idStyle, block.calloutTitle]).toEqual(["callout", "c1", "trailing", "Título breve"]);
		expect(block.raw).toBe("> [!note] Título breve");
	});

	it("strips a trailing id placed after an inline comment", () => {
		const b = only(["Algún palomino de %%p. 2%% añadidura los domingos. %%nota%% ^p1"]);
		expect(b.id).toBe("p1");
		expect(b.idStyle).toBe("trailing");
		expect(b.idLine).toBe(0);
		expect(b.raw).toBe("Algún palomino de %%p. 2%% añadidura los domingos. %%nota%%");
	});

	it("keeps a hard break's two spaces when stripping a trailing id", () => {
		expect(only(["Línea con salto   ^intro-1"]).raw).toBe("Línea con salto  ");
	});

	it("takes a trailing id only from the last line of a paragraph", () => {
		const s = parse(["Primera ^x", "segunda ^p2"]);
		expect(s.blocks[0]?.id).toBe("p2");
		expect(s.blocks[0]?.raw).toBe("Primera ^x\nsegunda");
		expect([...s.usedIds].sort()).toEqual(["p2", "x"]);
	});

	it.each([
		["quote", ["> Cita."]],
		["callout", ["> [!quote] Título", "> Cuerpo."]],
		["list", ["- uno", "- dos"]],
		["table", ["| a | b |", "|---|---|", "| 1 | 2 |"]],
	])("attaches an own-line id after a blank line to a %s", (kind, lines) => {
		const s = parse([...lines, "", "^p7", "", "Después."]);
		const [block, after] = s.blocks;
		expect(block?.kind).toBe(kind);
		expect(block?.id).toBe("p7");
		expect(block?.idStyle).toBe("own-line");
		expect(block?.idLine).toBe(lines.length + 1);
		expect(block?.lines).toEqual({ start: 0, end: lines.length });
		expect(block?.raw).toBe(lines.join("\n"));
		expect(after?.kind).toBe("paragraph");
		expect(s.blocks).toHaveLength(2);
	});

	it("records list item ids as used without giving the list an id", () => {
		const s = parse(["- primero ^item-1", "- segundo ^item-2", "", "^lista"]);
		const list = s.blocks[0];
		expect(list?.id).toBe("lista");
		expect(list?.raw).toBe("- primero ^item-1\n- segundo ^item-2");
		expect([...s.usedIds].sort()).toEqual(["item-1", "item-2", "lista"]);
		const bare = parse(["- primero ^item-1", "- segundo ^item-2"]);
		expect(bare.blocks[0]?.id).toBeNull();
		expect([...bare.usedIds].sort()).toEqual(["item-1", "item-2"]);
	});

	it("keeps an own-line id that follows nothing it can attach to as verbatim, but reserves it", () => {
		const s = parse(["## Título", "", "^suelto"]);
		expect(s.blocks.map((b) => b.kind)).toEqual(["heading", "verbatim"]);
		expect(s.usedIds.has("suelto")).toBe(true);
	});
});

describe("parseNote: regions", () => {
	const options: ParseOptions = { textStartHeading: "Text", skipHeadings: ["Bibliografía", "Argument"] };

	it("marks everything through the start heading as preamble", () => {
		const s = parse(["# Título", "", "Botones.", "", "# text", "", "Párrafo."], options);
		expect(s.blocks.map((b) => b.region)).toEqual(["preamble", "preamble", "preamble", "text"]);
	});

	it("matches the start heading at any level", () => {
		const s = parse(["Antes.", "", "### Text", "", "Después."], options);
		expect(s.blocks.map((b) => b.region)).toEqual(["preamble", "preamble", "text"]);
	});

	it("treats the whole note as text when the start heading is absent", () => {
		const s = parse(["Párrafo.", "", "## Otro"], options);
		expect(s.blocks.map((b) => b.region)).toEqual(["text", "text"]);
	});

	it("skips a section up to the next heading of the same or higher level", () => {
		const s = parse(
			["# Text", "## Bibliografía", "- obra", "### Sub", "Nota.", "## Después", "Texto.", "### Argument", "Mío.", "#### Más", "Mío también."],
			options,
		);
		expect(s.blocks.map((b) => `${b.kind}:${b.region}`)).toEqual([
			"heading:preamble",
			"heading:skipped",
			"list:skipped",
			"heading:skipped",
			"paragraph:skipped",
			"heading:text",
			"paragraph:text",
			"heading:skipped",
			"paragraph:skipped",
			"heading:skipped",
			"paragraph:skipped",
		]);
	});

	it("never skips footnote definitions", () => {
		const s = parse(["## Bibliografía", "", "- obra", "", "[^1]: Nota."], options);
		expect(s.blocks.map((b) => b.region)).toEqual(["skipped", "skipped", "text"]);
	});

	it("matches skip headings case-insensitively after trimming", () => {
		const s = parse(["##   BIBLIOGRAFÍA  ", "- obra"], options);
		expect(s.blocks.map((b) => b.region)).toEqual(["skipped", "skipped"]);
	});
});

describe("parseNote: safe text start when no start heading is set (#26)", () => {
	const AUTO: ParseOptions = { textStartHeading: "", skipHeadings: [], autoTextStart: true };
	const ZOTERO = "🔗 [Open in Zotero](zotero://select/library/items/ABCD1234)";

	it("starts after a heading named Text, at any level and in any case", () => {
		const s = parse(["# Las versiones homéricas", "", ZOTERO, "", "Notas de clase.", "", "## TEXT", "", "Párrafo."], AUTO);
		expect(s.blocks.map((b) => b.region)).toEqual(["preamble", "preamble", "preamble", "preamble", "text"]);
	});

	it("leaves out leading link, button and embed lines when there is no Text heading", () => {
		const s = parse([ZOTERO, "`BUTTON[open-pdf]` `BUTTON[sync]`", "", "![[Text.base]]", "", "- [PDF](file:///tmp/a.pdf)", "", "Ninguno de los problemas.", "", "[[Más tarde]]"], AUTO);
		expect(s.blocks.map((b) => `${b.kind}:${b.region}`)).toEqual([
			"paragraph:preamble",
			"verbatim:preamble",
			"list:preamble",
			"paragraph:text",
			"paragraph:text",
		]);
		expect(textUnits(s)[0]?.body).toBe("Ninguno de los problemas.");
	});

	it("stops the metadata run at a heading, a callout or any prose", () => {
		expect(parse([ZOTERO, "", "# Título", "", ZOTERO], AUTO).blocks.map((b) => b.region)).toEqual(["preamble", "text", "text"]);
		expect(parse(["> [!info] Resumen", "> Algo.", "", ZOTERO], AUTO).blocks.map((b) => b.region)).toEqual(["text", "text"]);
		expect(parse(["Véase [la nota](https://example.org) del editor.", "", "Más."], AUTO).blocks.map((b) => b.region)).toEqual(["text", "text"]);
	});

	it("keeps the old whole-note text region when a preamble block already has a Menard id", () => {
		const s = parse([`${ZOTERO} ^p1`, "", "Párrafo. ^p2"], AUTO);
		expect(s.blocks.map((b) => b.region)).toEqual(["text", "text"]);
		const t = parse(["Notas. ^p1", "", "# Text", "", "Párrafo. ^p2"], AUTO);
		expect(t.blocks.map((b) => b.region)).toEqual(["text", "text", "text"]);
	});

	it("does nothing without autoTextStart, as for translation notes", () => {
		const s = parse([ZOTERO, "", "# Text", "", "Párrafo."], ALL_TEXT);
		expect(s.blocks.map((b) => b.region)).toEqual(["text", "text", "text"]);
	});

	it.each([
		[ZOTERO, true],
		["`BUTTON[open-zotero]`", true],
		["BUTTON[open-zotero]", true],
		["[[Borges, Jorge Luis]] · <https://example.org>", true],
		["https://example.org/a ^meta", true],
		["Leído en [Sur](https://example.org).", false],
		["Sin enlaces.", false],
	])("isMetadataLine(%s) is %s", (line, expected) => {
		expect(isMetadataLine(line)).toBe(expected);
	});
});

describe("textUnits and isSentenceUnit", () => {
	it("returns unit kinds in the text region only", () => {
		const s = parse(
			["# Título", "", "# Text", "", "Párrafo.", "", "---", "", "%%menard:1 p1 translate%%", "", "## Bibliografía", "", "- obra", "", "[^1]: Nota."],
			{ textStartHeading: "Text", skipHeadings: ["Bibliografía"] },
		);
		expect(textUnits(s).map((b) => b.kind)).toEqual(["paragraph", "footnote"]);
	});

	it("names the sentence-unit kinds", () => {
		const kinds: UnitKind[] = ["paragraph", "quote", "callout", "list", "table", "footnote", "heading"];
		expect(kinds.filter(isSentenceUnit)).toEqual(["paragraph", "quote", "callout"]);
	});
});
