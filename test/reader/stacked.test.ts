// @vitest-environment happy-dom
import { Component } from "obsidian";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { StackedGloss } from "../../src/reader/stacked";
import type { GlossSource } from "../../src/types";
import type { FakeScroller } from "./fakes";
import { FakeGlossSource, fakeModel, fakeScroller, frag, h, installObsidianDom, rect, section, spanishSections, unitEl } from "./fakes";

beforeAll(installObsidianDom);

const model = fakeModel();
let container: HTMLElement;
let scroller: FakeScroller;
let source: FakeGlossSource;
let owner: Component;
let slot: StackedGloss;

beforeEach(() => {
	container = h("div", { class: "markdown-preview-sizer" }, ...spanishSections());
	scroller = fakeScroller(h("div", { class: "markdown-preview-view" }, container));
	document.body.replaceChildren(scroller.el);
	source = new FakeGlossSource();
	owner = new Component();
	owner.load();
	slot = new StackedGloss(source, owner);
});

const q = (selector: string): HTMLElement => {
	const el = container.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
};
const glosses = () => Array.from(container.querySelectorAll(`.${CLS.gloss}`));

describe("StackedGloss.show", () => {
	it("puts one gloss note after the link's last fragment, its footnote ref included", async () => {
		await slot.show(container, scroller.el, model, { unit: "p1", link: 2 }, false);
		const [gloss] = glosses();
		expect(glosses()).toHaveLength(1);
		expect(gloss?.getAttribute("role")).toBe("note");
		expect(gloss?.getAttribute("lang")).toBe("en");
		expect(gloss?.textContent).toBe("EN p1.2");
		expect(gloss?.previousElementSibling?.classList.contains("footnote-ref")).toBe(true);
	});

	it("climbs out of italics that the link's last fragment closes", async () => {
		const unit = unitEl("p", "p5", frag("p5.1", "Así lo dice el "), h("em", {}, frag("p5.1", "Quijote")), " ", frag("p5.2", "Fin."));
		container.append(section(unit));
		await slot.show(container, scroller.el, model, { unit: "p5", link: 1 }, false);
		const gloss = glosses()[0];
		expect(gloss?.parentElement).toBe(unit);
		expect(gloss?.previousElementSibling?.tagName).toBe("EM");
	});

	it("puts a whole-unit gloss after the unit element", async () => {
		await slot.show(container, scroller.el, model, { unit: "p3", link: null }, false);
		expect(glosses()[0]?.previousElementSibling?.getAttribute(ATTR.unit)).toBe("p3");
	});

	it("re-places a whole-unit gloss whose clone keeps the unit attribute", async () => {
		const cloning: GlossSource = {
			render: (_model, stop, into) => {
				into.append(h("ul", { [ATTR.unit]: stop.unit }, h("li", {}, "Clone")));
				return Promise.resolve(true);
			},
		};
		const whole = new StackedGloss(cloning, owner);
		const p3 = q(`[${ATTR.unit}="p3"]`);
		await whole.show(container, scroller.el, model, { unit: "p3", link: null }, false);
		await whole.show(container, scroller.el, model, { unit: "p3", link: null }, false);
		expect(glosses()).toHaveLength(1);
		expect(glosses()[0]?.previousElementSibling).toBe(p3);
	});

	it("keeps a single slot as the cursor moves, re-rendering only for a new stop", async () => {
		await slot.show(container, scroller.el, model, { unit: "p1", link: 1 }, false);
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		expect(glosses()).toHaveLength(1);
		expect(glosses()[0]?.textContent).toBe("EN p2.1");
		expect(source.calls).toEqual(["p1.1", "p2.1"]);
	});

	it("re-renders when the model version changes", async () => {
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		await slot.show(container, scroller.el, fakeModel(undefined, 2), { unit: "p2", link: 1 }, false);
		expect(source.calls).toEqual(["p2.1", "p2.1"]);
	});

	it("removes the slot when there is nothing to show", async () => {
		await slot.show(container, scroller.el, model, { unit: "p1", link: 1 }, false);
		source.empty.add("p2.2");
		await slot.show(container, scroller.el, model, { unit: "p2", link: 2 }, false);
		expect(glosses()).toHaveLength(0);
	});

	it("keeps only the latest of two overlapping shows", async () => {
		const first = slot.show(container, scroller.el, model, { unit: "p1", link: 1 }, false);
		const second = slot.show(container, scroller.el, model, { unit: "p2", link: 2 }, false);
		await Promise.all([first, second]);
		expect(glosses().map((g) => g.textContent)).toEqual(["EN p2.2"]);
	});

	it("compensates the reflow so the current sentence does not move", async () => {
		const anchor = q(`[${ATTR.link}="p2.1"]`);
		const p1 = q(`[${ATTR.unit}="p1"]`);
		// The gloss is 60 px tall; while it sits in p1 it pushes p2 down.
		anchor.getBoundingClientRect = () => rect(500 - scroller.el.scrollTop + (p1.querySelector(`.${CLS.gloss}`) ? 60 : 0), 24);
		await slot.show(container, scroller.el, model, { unit: "p1", link: 3 }, false);
		scroller.el.scrollTop = 300;
		const before = anchor.getBoundingClientRect().top;
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		expect(scroller.el.scrollTop).toBe(240);
		expect(anchor.getBoundingClientRect().top).toBe(before);
	});

	it("does not scroll when nothing above the current sentence changes", async () => {
		scroller.el.scrollTop = 300;
		const anchor = q(`[${ATTR.link}="p2.1"]`);
		anchor.getBoundingClientRect = () => rect(500 - scroller.el.scrollTop, 24);
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		expect(scroller.el.scrollTop).toBe(300);
	});
});

describe("reveal mode", () => {
	it("conceals with an accessible label, and reveals in place", async () => {
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, true);
		const gloss = glosses()[0];
		expect(gloss?.classList.contains(CLS.concealed)).toBe(true);
		expect(gloss?.getAttribute("aria-label")).toBe("Translation hidden");
		scroller.el.scrollTop = 120;
		slot.reveal(scroller.el);
		expect(gloss?.classList.contains(CLS.concealed)).toBe(false);
		expect(gloss?.hasAttribute("aria-label")).toBe(false);
		expect(scroller.el.scrollTop).toBe(120);
	});

	it("conceals again when shown concealed for the next stop", async () => {
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, true);
		slot.reveal(scroller.el);
		await slot.show(container, scroller.el, model, { unit: "p2", link: 2 }, true);
		expect(glosses()[0]?.classList.contains(CLS.concealed)).toBe(true);
	});
});

describe("remove and ghost", () => {
	it("unloads each render owner when its gloss is replaced or removed", async () => {
		await slot.show(container, scroller.el, model, { unit: "p1", link: 1 }, false);
		await slot.show(container, scroller.el, model, { unit: "p2", link: 1 }, false);
		expect(source.unloaded).toEqual(["p1.1"]);
		slot.remove(scroller.el);
		expect(glosses()).toHaveLength(0);
		expect(source.unloaded).toEqual(["p1.1", "p2.1"]);
	});

	it("shows a ghost card that never reflows and hides it", async () => {
		scroller.el.scrollTop = 200;
		await slot.showGhost(container, model, { unit: "p2", link: 2 });
		const ghost = container.querySelector(`.${CLS.ghost}`);
		expect(ghost?.getAttribute("aria-hidden")).toBe("true");
		expect(ghost?.textContent).toBe("EN p2.2");
		expect(ghost?.previousElementSibling?.getAttribute(ATTR.link)).toBe("p2.2");
		expect(scroller.el.scrollTop).toBe(200);
		slot.hideGhost();
		expect(container.querySelector(`.${CLS.ghost}`)).toBeNull();
	});

	it("drops a ghost whose render finished after it was hidden", async () => {
		const pending = slot.showGhost(container, model, { unit: "p2", link: 2 });
		slot.hideGhost();
		await pending;
		expect(container.querySelector(`.${CLS.ghost}`)).toBeNull();
	});
});
