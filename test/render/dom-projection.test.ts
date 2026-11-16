// @vitest-environment happy-dom
import { section } from "./dom-env";
import { describe, expect, it } from "vitest";
import { projectElement, SKIP_SELECTORS } from "../../src/render/dom-projection";

function unit(html: string): HTMLElement {
	return section(html).firstElementChild as HTMLElement;
}

describe("projectElement", () => {
	it("keeps visible text and maps every piece back to its text node", () => {
		const p = unit("<p>Según el <em>Sr.</em> Pérez, «la <a class=\"internal-link\" href=\"x\">obra</a>» perdura.</p>");
		const { text, pieces } = projectElement(p);
		expect(text).toBe("Según el Sr. Pérez, «la obra» perdura.");
		for (const piece of pieces) expect(text.slice(piece.start, piece.start + piece.node.data.length)).toBe(piece.node.data);
		expect(pieces.map((piece) => piece.node.data)).toEqual(["Según el ", "Sr.", " Pérez, «la ", "obra", "» perdura."]);
	});

	it("skips footnote refs, code, math, embeds and Menard's own elements", () => {
		const p = unit(
			'<p>Leyó a Poe.<sup data-footnote-id="fnref-2-a" class="footnote-ref"><a href="#fn-2-a">[2]</a></sup> Usa <code>grep -i</code> y ' +
				'<span class="math math-inline">x+1</span> con <span class="internal-embed image-embed">mapa.png</span>' +
				'<span class="menard-gloss">He read Poe.</span><span class="menard-ghost">ghost</span>fin.</p>',
		);
		expect(projectElement(p).text).toBe("Leyó a Poe. Usa  y  con fin.");
	});

	it("skips a footnote ref known only by its data attribute", () => {
		const p = unit('<p>Texto<sup data-footnote-id="fnref-en-3-b"><a href="#fn">[3]</a></sup> sigue.</p>');
		expect(projectElement(p).text).toBe("Texto sigue.");
	});

	it("skips the callout title but keeps its body", () => {
		const callout = unit(
			'<div class="callout" data-callout="note"><div class="callout-title"><div class="callout-title-inner">Procedencia</div></div>' +
				'<div class="callout-content"><p>Traducción de Ormsby.</p></div></div>',
		);
		expect(projectElement(callout).text).toBe("Traducción de Ormsby.");
	});

	it("skips code blocks and embedded notes", () => {
		const div = unit('<div><pre><code>%%menard:1 p1 1.aaaa/1.bbbb%%</code></pre><div class="markdown-embed">Otra nota</div><p>Sí.</p></div>');
		expect(projectElement(div).text).toBe("Sí.");
	});

	it("returns nothing for a root that is itself skipped", () => {
		expect(projectElement(unit("<pre><code>x = 1</code></pre>"))).toEqual({ text: "", pieces: [] });
	});

	it("inserts a virtual newline at each <br>", () => {
		const p = unit("<p>El río que no vuelve<br>es otro río</p>");
		const { text, pieces } = projectElement(p);
		expect(text).toBe("El río que no vuelve\nes otro río");
		expect(pieces[1]?.start).toBe(21);
	});

	it("separates blocks with one newline and keeps soft-break text as is", () => {
		const quote = unit("<blockquote>\n<p>Primer verso,<br>\nsegundo verso;</p>\n<p>— Anónimo</p>\n</blockquote>");
		const { text } = projectElement(quote);
		expect(text.split(/\n+/).map((line) => line.trim()).filter(Boolean)).toEqual(["Primer verso,", "segundo verso;", "— Anónimo"]);
		expect(text).toContain("segundo verso;\n");
		expect(text).not.toContain("verso;— ");
	});

	it("separates list items", () => {
		const list = unit("<ul><li>uno</li><li>dos <em>tres</em></li></ul>");
		expect(projectElement(list).text).toBe("uno\ndos tres");
	});

	it("normalizes decomposed text to NFC", () => {
		const p = unit("<p>vivía</p>");
		expect(projectElement(p).text).toBe("vivía");
	});

	it("exports the skip list the spike adjusts", () => {
		expect(SKIP_SELECTORS).toEqual(
			expect.arrayContaining(["sup.footnote-ref", "code", "pre", ".math", ".internal-embed", ".markdown-embed", ".callout-title", ".menard-gloss", ".menard-ghost"]),
		);
	});
});
