// @vitest-environment happy-dom
import { htmlSetterSpy, section } from "./dom-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { projectElement } from "../../src/render/dom-projection";
import { unwrapAll, wrapRanges } from "../../src/render/wrap";
import type { CharRange } from "../../src/types";

const spy = htmlSetterSpy();
afterEach(() => {
	expect(spy.calls()).toBe(0);
});
beforeEach(() => spy.arm());

function wrap(html: string, sentences: readonly string[], classes: (i: number) => readonly string[] = () => []): HTMLElement {
	const p = section(html).firstElementChild as HTMLElement;
	const before = p.textContent;
	const projection = projectElement(p);
	const ranges: CharRange[] = [];
	let from = 0;
	for (const sentence of sentences) {
		const start = projection.text.indexOf(sentence, from);
		if (start < 0) throw new Error(`not in projection: ${sentence}`);
		ranges.push({ start, end: start + sentence.length });
		from = start + sentence.length;
	}
	wrapRanges(projection, ranges, (i) => `p7.${i + 1}`, classes);
	expect(p.textContent).toBe(before);
	return p;
}

function textOf(p: HTMLElement, link: string): string {
	return Array.from(p.querySelectorAll(`span.${CLS.sentence}[${ATTR.link}="${link}"]`))
		.map((span) => span.textContent)
		.join("");
}

describe("wrapRanges", () => {
	it("runs under a working innerHTML spy", () => {
		expect(spy.installed()).toBeGreaterThan(0);
		const probe = htmlSetterSpy();
		probe.arm();
		Reflect.set(document.createElement("div"), "innerHTML", "<b>x</b>");
		expect(probe.calls()).toBe(1);
		probe.restore();
		// The probe's write also reached the outer spy; discount it.
		spy.reset();
	});

	it("wraps each sentence of a plain paragraph in one span", () => {
		const p = wrap("<p>Según el Sr. Pérez, Borges leyó a Poe. Esa lectura fue decisiva.</p>", [
			"Según el Sr. Pérez, Borges leyó a Poe. ",
			"Esa lectura fue decisiva.",
		]);
		expect(p.querySelectorAll("span.menard-s")).toHaveLength(2);
		expect(textOf(p, "p7.1")).toBe("Según el Sr. Pérez, Borges leyó a Poe.");
		expect(textOf(p, "p7.2")).toBe("Esa lectura fue decisiva.");
	});

	it("splits a range crossing <em> and <a> into spans that share one attribute, leaving the anchor intact", () => {
		const html =
			'<p>Como señala <a class="internal-link" data-href="Lacan, Jacques" href="Lacan, Jacques">Jacques <em>Lacan</em>, en sus «Escritos»</a>, el deseo es el deseo del Otro. ' +
			"Lo <em>repite</em> después.</p>";
		const p = section(html).firstElementChild as HTMLElement;
		const anchor = p.querySelector("a") as HTMLAnchorElement;
		const em = anchor.querySelector("em");
		const projection = projectElement(p);
		const cut = projection.text.indexOf("Lo ");
		wrapRanges(projection, [{ start: 0, end: cut }, { start: cut, end: projection.text.length }], (i) => `p3.${i + 1}`, () => []);

		const first = Array.from(p.querySelectorAll(`[${ATTR.link}="p3.1"]`));
		expect(first.length).toBeGreaterThan(2);
		expect(first.every((el) => el.tagName === "SPAN" && el.classList.contains(CLS.sentence))).toBe(true);
		expect(first.map((el) => el.textContent).join("")).toBe("Como señala Jacques Lacan, en sus «Escritos», el deseo es el deseo del Otro.");
		expect(p.querySelector("a")).toBe(anchor);
		expect(anchor.getAttribute("href")).toBe("Lacan, Jacques");
		expect(anchor.getAttribute("data-href")).toBe("Lacan, Jacques");
		expect(anchor.textContent).toBe("Jacques Lacan, en sus «Escritos»");
		expect(anchor.querySelector("em")).toBe(em);
		expect(anchor.parentElement).toBe(p);
		expect(textOf(p, "p3.2")).toBe("Lo repite después.");
	});

	it("gives a footnote ref right after a range's last piece the range's attribute", () => {
		const p = wrap(
			'<p>Leyó a Poe en <em>Ginebra</em>.<sup data-footnote-id="fnref-2-a" class="footnote-ref"><a href="#fn-2-a">[2]</a></sup> Esa lectura fue <em>decisiva</em><sup class="footnote-ref"><a href="#fn-3">[3]</a></sup></p>',
			["Leyó a Poe en Ginebra. ", "Esa lectura fue decisiva"],
		);
		const sups = p.querySelectorAll("sup");
		expect(sups[0]?.getAttribute(ATTR.link)).toBe("p7.1");
		expect(sups[0]?.classList.contains(CLS.sentence)).toBe(false);
		expect(sups[1]?.getAttribute(ATTR.link)).toBe("p7.2");
		expect(sups[0]?.querySelector("a")?.getAttribute("href")).toBe("#fn-2-a");
	});

	it("does not tag a footnote ref separated from the range by text", () => {
		const p = wrap('<p>Uno. Dos<sup class="footnote-ref"><a href="#fn-1">[1]</a></sup></p>', ["Uno. "]);
		expect(p.querySelector("sup")?.hasAttribute(ATTR.link)).toBe(false);
	});

	it("applies the per-range classes", () => {
		const p = wrap("<p>Uno. Dos.</p>", ["Uno. ", "Dos."], (i) => (i === 1 ? [CLS.flagged, CLS.approximate] : []));
		const spans = p.querySelectorAll("span.menard-s");
		expect(spans[0]?.className).toBe("menard-s");
		expect(spans[1]?.classList.contains(CLS.flagged)).toBe(true);
		expect(spans[1]?.classList.contains(CLS.approximate)).toBe(true);
	});

	it("skips empty and whitespace-only ranges", () => {
		const p = section("<p>Uno. Dos.</p>").firstElementChild as HTMLElement;
		const projection = projectElement(p);
		wrapRanges(projection, [{ start: 0, end: 0 }, { start: 4, end: 5 }, { start: 5, end: 9 }], (i) => `k.${i + 1}`, () => []);
		expect(Array.from(p.querySelectorAll("span.menard-s")).map((s) => s.getAttribute(ATTR.link))).toEqual(["k.3"]);
		expect(p.textContent).toBe("Uno. Dos.");
	});

	it("keeps whitespace at the edges of a range outside its span", () => {
		const p = wrap("<p>Uno.   Dos.</p>", ["Uno.   ", "Dos."]);
		expect(p.querySelectorAll("span.menard-s")[0]?.textContent).toBe("Uno.");
	});

	it("wraps across <br> and block boundaries of a quote", () => {
		const p = wrap("<blockquote><p>Primer verso,<br>segundo verso;</p><p>— Anónimo</p></blockquote>", ["Primer verso,\nsegundo verso;", "— Anónimo"]);
		expect(textOf(p, "p7.1")).toBe("Primer verso,segundo verso;");
		expect(p.querySelectorAll(`[${ATTR.link}="p7.1"]`)).toHaveLength(2);
		expect(p.querySelector("br")?.parentElement?.tagName).toBe("P");
	});

	it("leaves skipped elements outside the spans", () => {
		const p = wrap("<p>Usa <code>grep</code> aquí. Fin.</p>", ["Usa  aquí. ", "Fin."]);
		expect(p.querySelector("code")?.parentElement).toBe(p);
		expect(p.querySelector("code")?.closest("span.menard-s")).toBeNull();
	});

	it("handles decomposed characters by their NFC offsets", () => {
		const p = wrap("<p>Vivía allí. Fin.</p>", ["Vivía allí. ", "Fin."]);
		expect(textOf(p, "p7.1").normalize("NFC")).toBe("Vivía allí.");
		expect(textOf(p, "p7.2")).toBe("Fin.");
	});

	it("never splits a composed character whose parts are not combining marks", () => {
		// Conjoining Hangul jamo: "가나" decomposed into four code points, none of them \p{M}.
		const p = section(`<p>${"가나"}</p>`).firstElementChild as HTMLElement;
		const projection = projectElement(p);
		expect(projection.text).toBe("가나");
		wrapRanges(projection, [{ start: 0, end: 1 }, { start: 1, end: 2 }], (i) => `p7.${i + 1}`, () => []);
		expect(textOf(p, "p7.1")).toBe("가");
		expect(textOf(p, "p7.2")).toBe("나");
	});

	it("cuts long decomposed text at the right characters", () => {
		const sentence = "Él leyó «Pierre Menard» en Ginebra, según él mismo. ".normalize("NFD");
		const text = sentence.repeat(40);
		const p = section(`<p>${text}</p>`).firstElementChild as HTMLElement;
		const projection = projectElement(p);
		const length = sentence.normalize("NFC").length;
		const ranges = Array.from({ length: 40 }, (_, i) => ({ start: i * length, end: (i + 1) * length }));
		wrapRanges(projection, ranges, (i) => `p7.${i + 1}`, () => []);
		expect(p.textContent).toBe(text);
		for (const i of [1, 20, 40]) expect(textOf(p, `p7.${i}`).normalize("NFC")).toBe(sentence.normalize("NFC").trimEnd());
	});

	it("unwrapAll restores the text and removes the attributes", () => {
		const p = wrap('<p>Uno<sup class="footnote-ref"><a href="#f">[1]</a></sup> <em>Dos</em>.</p>', ["Uno", "Dos."]);
		unwrapAll(p);
		expect(p.querySelectorAll("span.menard-s")).toHaveLength(0);
		expect(p.querySelector(`[${ATTR.link}]`)).toBeNull();
		expect(p.textContent).toBe("Uno[1] Dos.");
	});
});
