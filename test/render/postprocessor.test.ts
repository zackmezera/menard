// @vitest-environment happy-dom
import { htmlSetterSpy, section } from "./dom-env";
import type { Events } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sideSig } from "../../src/align/signature";
import { wordsOf } from "../../src/align/words";
import { ATTR, CLS } from "../../src/constants";
import { createPostProcessor, DONE_ATTR } from "../../src/render/postprocessor";
import type { MapLink, PairModel, SectionListener } from "../../src/types";
import { block, FakePairs, fakeApp, fakeContext, fakeModel, fakeSection, linksOf, SOURCE_PATH, TARGET_PATH } from "./fakes";
import {
	QUIJOTE_MAP,
	QUIJOTE_SOURCE_HTML,
	QUIJOTE_SOURCE_NOTE,
	QUIJOTE_SOURCE_S1,
	QUIJOTE_SOURCE_S2,
	QUIJOTE_TARGET_EDITED_HTML,
	QUIJOTE_TARGET_HTML,
	QUIJOTE_TARGET_NOTE,
	QUIJOTE_TARGET_S1,
} from "./fixtures";

const spy = htmlSetterSpy();
beforeEach(() => spy.reset());
afterEach(() => expect(spy.calls()).toBe(0));

function quijoteModel(links: MapLink[] = linksOf(QUIJOTE_MAP), version = 1): PairModel {
	return fakeModel([{ key: "p1", source: block("paragraph", 4, 5, "p1"), target: block("paragraph", 6, 7, "p1"), links, mapLine: 8 }], version);
}

let metadataCache: Events;

function setup(model: PairModel | null = quijoteModel()) {
	const fake = fakeApp({ [SOURCE_PATH]: QUIJOTE_SOURCE_NOTE, [TARGET_PATH]: QUIJOTE_TARGET_NOTE });
	const { app } = fake;
	metadataCache = fake.metadataCache;
	const pairs = new FakePairs(model);
	const sectionRendered = vi.fn();
	const listener: SectionListener = { sectionRendered };
	const processor = createPostProcessor(fakeContext(app), pairs, listener);
	return { pairs, sectionRendered, processor };
}

/** Builds the section after the spy's reset so only the processor's writes count. */
function sourceSection(html = QUIJOTE_SOURCE_HTML): HTMLElement {
	const el = section(html);
	spy.arm();
	return el;
}

function linkText(el: HTMLElement, link: string): string {
	return Array.from(el.querySelectorAll(`span.${CLS.sentence}[${ATTR.link}="${link}"]`))
		.map((span) => span.textContent)
		.join("");
}

describe("createPostProcessor on the Quijote pair", () => {
	it("wraps the source paragraph in two links cut after 'corredor.', with its footnote ref", async () => {
		const { processor, sectionRendered } = setup();
		const el = sourceSection();
		const before = el.textContent;
		const { ctx, addChild } = fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 });
		await processor(el, ctx);

		const p = el.querySelector("p") as HTMLElement;
		expect(p.getAttribute(ATTR.unit)).toBe("p1");
		expect(p.getAttribute(ATTR.fit)).toBe("exact");
		expect(p.getAttribute("lang")).toBe("es");
		expect(linkText(el, "p1.1")).toBe(QUIJOTE_SOURCE_S1);
		expect(linkText(el, "p1.2")).toBe(QUIJOTE_SOURCE_S2.replace("de añadidura", "de  añadidura"));
		expect(el.querySelector("sup.footnote-ref")?.getAttribute(ATTR.link)).toBe("p1.1");
		expect(el.querySelectorAll(`span.${CLS.sentence}`)).toHaveLength(2);
		expect(el.querySelector(`.${CLS.flagged}, .${CLS.loose}, .${CLS.approximate}`)).toBeNull();
		expect(el.textContent).toBe(before);
		expect(el.getAttribute(DONE_ATTR)).toBe("1");
		expect(addChild).toHaveBeenCalledTimes(1);
		expect(sectionRendered).toHaveBeenCalledWith(SOURCE_PATH, el);
	});

	it("wraps the target paragraph with the same keys", async () => {
		const { processor } = setup();
		const el = sourceSection(QUIJOTE_TARGET_HTML);
		await processor(el, fakeSection({ sourcePath: TARGET_PATH, text: QUIJOTE_TARGET_NOTE, lineStart: 6 }).ctx);
		expect(el.querySelector("p")?.getAttribute("lang")).toBe("en");
		expect(linkText(el, "p1.1")).toBe(QUIJOTE_TARGET_S1);
		expect(linkText(el, "p1.2")).toMatch(/^An olla .* income\.$/);
		expect(el.querySelector("p")?.getAttribute(ATTR.fit)).toBe("exact");
	});

	it("still wraps an edited target, with link 2 refitted", async () => {
		const { processor } = setup();
		const el = sourceSection(QUIJOTE_TARGET_EDITED_HTML);
		await processor(el, fakeSection({ sourcePath: TARGET_PATH, text: QUIJOTE_TARGET_NOTE, lineStart: 6 }).ctx);
		expect(el.querySelector("p")?.getAttribute(ATTR.fit)).toBe("repaired");
		expect(linkText(el, "p1.1")).toBe(QUIJOTE_TARGET_S1);
		expect(linkText(el, "p1.2")).toContain("and a fat pigeon");
		expect(el.querySelector(`.${CLS.approximate}`)).toBeNull();
	});

	it("marks flagged and loose links", async () => {
		const [first, second] = linksOf(QUIJOTE_MAP) as [MapLink, MapLink];
		const { processor } = setup(quijoteModel([{ ...first, loose: true }, { ...second, tgt: null }]));
		const el = sourceSection();
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx);
		const spans = el.querySelectorAll(`span.${CLS.sentence}`);
		expect(spans[0]?.classList.contains(CLS.loose)).toBe(true);
		expect(spans[0]?.classList.contains(CLS.flagged)).toBe(false);
		expect(spans[1]?.classList.contains(CLS.flagged)).toBe(true);
	});

	it("marks links whose position was estimated", async () => {
		const sentences = [
			"Según el Sr. Pérez, J. L. Borges leyó a Poe en Ginebra.",
			"Esa lectura, dice, fue decisiva para su obra.",
			"Lo repite en «Pierre Menard» (1939).",
			"El resto es conjetura.",
		];
		const words = wordsOf(sentences.join(" "));
		let at = 0;
		const links: MapLink[] = sentences.map((s) => {
			const n = wordsOf(s).length;
			const sig = sideSig(words, { start: at, end: at + n });
			at += n;
			return { src: sig, tgt: sig, loose: false };
		});
		const edited = [sentences[0], "Esa lectura temprana, dice él, fue decisiva para toda su obra.", "Lo repite, con ironía, en «Pierre Menard» (1939).", sentences[3]];
		const { processor } = setup(fakeModel([{ key: "p1", source: block("paragraph", 4, 5, "p1"), target: null, links }]));
		const el = sourceSection(`<p>${edited.join(" ")}</p>`);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx);
		expect(el.querySelector("p")?.getAttribute(ATTR.fit)).toBe("degraded");
		expect(el.querySelectorAll(`.${CLS.approximate}`).length).toBeGreaterThan(0);
		expect(linkText(el, "p1.1")).toBe(sentences[0]);
		expect(linkText(el, "p1.4")).toBe(sentences[3]);
	});
});

describe("createPostProcessor gating", () => {
	it("marks a Menard-line section and stops there", async () => {
		const { processor, sectionRendered } = setup();
		const el = sourceSection("<p></p>");
		await processor(el, fakeSection({ sourcePath: TARGET_PATH, text: QUIJOTE_TARGET_NOTE, lineStart: 8 }).ctx);
		expect(el.hasAttribute(ATTR.menardSection)).toBe(true);
		expect(el.querySelector(`[${ATTR.unit}]`)).toBeNull();
		expect(sectionRendered).not.toHaveBeenCalled();
	});

	it("does not mark an ordinary section of a pair note as a Menard line", async () => {
		const { processor } = setup();
		const el = sourceSection(QUIJOTE_TARGET_HTML);
		await processor(el, fakeSection({ sourcePath: TARGET_PATH, text: QUIJOTE_TARGET_NOTE, lineStart: 6, lineEnd: 8 }).ctx);
		expect(el.hasAttribute(ATTR.menardSection)).toBe(false);
	});

	it("does not mark a section holding only an own-line id as the unit", async () => {
		const note = "Uno. Dos.\n\n> Primer verso,\n> segundo verso.\n\n^p2\n";
		const { processor } = setup(fakeModel([{ key: "p2", kind: "quote", source: { ...block("quote", 2, 4, "p2"), idStyle: "own-line", idLine: 5 }, target: null }]));
		const quote = sourceSection("<blockquote><p>Primer verso,<br>segundo verso.</p></blockquote>");
		await processor(quote, fakeSection({ sourcePath: SOURCE_PATH, text: note, lineStart: 2, lineEnd: 3 }).ctx);
		expect(quote.querySelector("blockquote")?.getAttribute(ATTR.unit)).toBe("p2");
		const idOnly = sourceSection("<p></p>");
		await processor(idOnly, fakeSection({ sourcePath: SOURCE_PATH, text: note, lineStart: 5 }).ctx);
		expect(idOnly.querySelector(`[${ATTR.unit}]`)).toBeNull();
		expect(idOnly.hasAttribute(ATTR.menardSection)).toBe(true);
	});

	it("collapses a hidden section before the model loads, so Obsidian measures it at zero", () => {
		const { processor } = setup();
		const el = sourceSection("<p></p>");
		void processor(el, fakeSection({ sourcePath: TARGET_PATH, text: QUIJOTE_TARGET_NOTE, lineStart: 8 }).ctx);
		expect(el.hasAttribute(ATTR.menardSection)).toBe(true);
	});

	it("leaves a user's own-line block id alone", async () => {
		const note = "Uno. Dos.\n\n> Primer verso.\n\n^mine\n";
		const { processor } = setup();
		const el = sourceSection("<p></p>");
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: note, lineStart: 4 }).ctx);
		expect(el.hasAttribute(ATTR.menardSection)).toBe(false);
	});

	it("leaves notes without pair frontmatter untouched", async () => {
		const { processor, pairs, sectionRendered } = setup();
		for (const frontmatter of [null, { tags: ["texto"] }]) {
			const el = sourceSection();
			const before = el.outerHTML;
			await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, frontmatter }).ctx);
			expect(el.outerHTML).toBe(before);
		}
		expect(pairs.loads).toBe(0);
		expect(sectionRendered).not.toHaveBeenCalled();
	});

	it("leaves a note that has the keys but is not a pair untouched", async () => {
		const { processor, sectionRendered } = setup(null);
		const el = sourceSection();
		const before = el.outerHTML;
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, frontmatter: { source: "https://example.org" } }).ctx);
		expect(el.outerHTML).toBe(before);
		expect(sectionRendered).not.toHaveBeenCalled();
	});

	it("returns early when getSectionInfo is null", async () => {
		const { processor, pairs } = setup();
		const el = sourceSection();
		const before = el.outerHTML;
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, sectionInfo: false }).ctx);
		expect(el.outerHTML).toBe(before);
		expect(pairs.loads).toBe(0);
	});

	it("skips sections inside an offscreen container", async () => {
		const { processor, pairs } = setup();
		const offscreen = document.createElement("div");
		offscreen.setAttribute(ATTR.offscreen, "");
		const el = sourceSection();
		offscreen.appendChild(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx);
		expect(el.querySelector(`span.${CLS.sentence}`)).toBeNull();

		const detached = sourceSection();
		await processor(detached, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, containerEl: offscreen }).ctx);
		expect(detached.querySelector(`span.${CLS.sentence}`)).toBeNull();
		expect(pairs.loads).toBe(0);
	});

	it("skips renders inside a hover popover or an embed", async () => {
		const { processor } = setup();
		for (const cls of ["hover-popover", "markdown-embed"]) {
			const host = document.createElement("div");
			host.className = cls;
			const containerEl = document.createElement("div");
			host.appendChild(containerEl);
			const el = sourceSection();
			await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, containerEl }).ctx);
			expect(el.querySelector(`span.${CLS.sentence}`)).toBeNull();
		}
	});

	it("is a no-op when run again for the same model version", async () => {
		const { processor, sectionRendered } = setup();
		const el = sourceSection();
		const first = fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 });
		await processor(el, first.ctx);
		const after = el.outerHTML;
		await processor(el, first.ctx);
		expect(el.outerHTML).toBe(after);
		expect(first.addChild).toHaveBeenCalledTimes(1);
		expect(sectionRendered).toHaveBeenCalledTimes(1);
	});

	it("drops stale marks and adds no second render child when a new version changes the unit", async () => {
		const { processor, pairs } = setup();
		const el = sourceSection();
		const before = el.textContent;
		const { ctx, addChild } = fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 });
		await processor(el, ctx);

		// Version 2: the unit lost its map.
		pairs.model = fakeModel([{ key: "p1", source: block("paragraph", 4, 5, "p1"), target: block("paragraph", 6, 7, "p1") }], 2);
		await processor(el, ctx);
		const p = el.querySelector("p") as HTMLElement;
		expect(p.getAttribute(ATTR.unit)).toBe("p1");
		expect(p.hasAttribute(ATTR.fit)).toBe(false);
		expect(el.querySelector(`span.${CLS.sentence}, [${ATTR.link}]`)).toBeNull();

		// Version 3: no unit at this line any more.
		pairs.model = fakeModel([], 3);
		await processor(el, ctx);
		expect(el.querySelector(`[${ATTR.unit}], [lang], [${ATTR.fit}]`)).toBeNull();
		expect(el.textContent).toBe(before);
		expect(addChild).toHaveBeenCalledTimes(1);
	});

	it("rewraps without nesting when the model version changes", async () => {
		const { processor, pairs } = setup();
		const el = sourceSection();
		const ctx = fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx;
		await processor(el, ctx);
		pairs.model = quijoteModel(linksOf(QUIJOTE_MAP), 2);
		await processor(el, ctx);
		expect(el.getAttribute(DONE_ATTR)).toBe("2");
		expect(el.querySelectorAll(`span.${CLS.sentence}`)).toHaveLength(2);
		expect(el.querySelector(`span.${CLS.sentence} span.${CLS.sentence}`)).toBeNull();
	});

	it("catches errors and logs them once", async () => {
		const { processor, pairs } = setup();
		pairs.load = () => Promise.reject(new Error("boom"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const ctx = fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx;
		await expect(processor(sourceSection(), ctx)).resolves.toBeUndefined();
		await expect(processor(sourceSection(), ctx)).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toBe("Menard:");
		log.mockRestore();
	});
});

describe("createPostProcessor revisits rendered sections", () => {
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	it("marks a section rendered before its note joined a pair, once the frontmatter changes", async () => {
		const { processor, pairs } = setup(null);
		const el = sourceSection();
		document.body.append(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, frontmatter: null }).ctx);
		expect(el.querySelector(`[${ATTR.unit}]`)).toBeNull();

		pairs.model = quijoteModel();
		metadataCache.trigger("changed", { path: SOURCE_PATH });
		await settle();
		expect(el.querySelector("p")?.getAttribute(ATTR.unit)).toBe("p1");
		expect(el.getAttribute(DONE_ATTR)).toBe("1");
		el.remove();
	});

	it("rewraps a section for a rebuilt model even when reading view does not render it again", async () => {
		const { processor, pairs } = setup();
		const el = sourceSection();
		document.body.append(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4 }).ctx);
		expect(el.getAttribute(DONE_ATTR)).toBe("1");

		pairs.rebuild(quijoteModel(linksOf(QUIJOTE_MAP), 2));
		await settle();
		expect(el.getAttribute(DONE_ATTR)).toBe("2");
		expect(el.querySelectorAll(`span.${CLS.sentence}`)).toHaveLength(2);
		el.remove();
	});

	/** A reading-view container in the document holding `el`, as Obsidian's sizer would. */
	function mounted(el: HTMLElement): { container: HTMLElement; sizer: HTMLElement } {
		const container = document.createElement("div");
		const sizer = document.createElement("div");
		container.append(sizer);
		sizer.append(el);
		document.body.append(container);
		return { container, sizer };
	}

	it("rewraps a section detached during a rebuild when reading view re-attaches it", async () => {
		const { processor, pairs, sectionRendered } = setup();
		const el = sourceSection();
		const { container, sizer } = mounted(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, containerEl: container }).ctx);
		expect(el.getAttribute(DONE_ATTR)).toBe("1");

		// Virtualization takes the section out; the model is rebuilt meanwhile.
		el.remove();
		await settle();
		pairs.rebuild(fakeModel([{ key: "p1", source: block("paragraph", 4, 5, "p1"), target: block("paragraph", 6, 7, "p1") }], 2));
		await settle();
		expect(el.getAttribute(DONE_ATTR)).toBe("1");

		sectionRendered.mockClear();
		sizer.append(el);
		await settle();
		expect(el.getAttribute(DONE_ATTR)).toBe("2");
		expect(el.querySelector(`span.${CLS.sentence}`)).toBeNull();
		expect(el.querySelector("p")?.getAttribute(ATTR.unit)).toBe("p1");
		expect(sectionRendered).toHaveBeenCalledWith(SOURCE_PATH, el);
		container.remove();
	});

	it("reports an up-to-date section again when it is re-attached, so its session repaints it", async () => {
		const { processor, sectionRendered } = setup();
		const el = sourceSection();
		const { container, sizer } = mounted(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, containerEl: container }).ctx);
		const wrapped = el.innerHTML;
		sectionRendered.mockClear();

		el.remove();
		await settle();
		sizer.append(el);
		await settle();
		expect(sectionRendered).toHaveBeenCalledTimes(1);
		expect(el.innerHTML).toBe(wrapped);
		container.remove();
	});

	it("forgets a view's detached sections once the view itself is gone", async () => {
		const { processor, pairs, sectionRendered } = setup();
		const el = sourceSection();
		const { container, sizer } = mounted(el);
		await processor(el, fakeSection({ sourcePath: SOURCE_PATH, text: QUIJOTE_SOURCE_NOTE, lineStart: 4, containerEl: container }).ctx);
		el.remove();
		container.remove();
		pairs.rebuild(quijoteModel(linksOf(QUIJOTE_MAP), 2));
		await settle();
		sectionRendered.mockClear();
		document.body.append(container);
		sizer.append(el);
		await settle();
		expect(el.getAttribute(DONE_ATTR)).toBe("1");
		expect(sectionRendered).not.toHaveBeenCalled();
		container.remove();
	});
});
