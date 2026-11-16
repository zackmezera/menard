// @vitest-environment happy-dom
import { Component } from "obsidian";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { attachPointer, linkFragments, queryAll, stopElements, stopFromTarget } from "../../src/reader/pointer";
import type { CursorStop } from "../../src/types";
import { h, installObsidianDom, spanishSections } from "./fakes";

beforeAll(installObsidianDom);

let root: HTMLElement;
beforeEach(() => {
	root = h("div", {}, ...spanishSections());
	document.body.replaceChildren(root);
});

const q = (selector: string): HTMLElement => {
	const el = root.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
};

describe("stopFromTarget", () => {
	it("reads the link of the closest fragment", () => {
		expect(stopFromTarget(q(`[${ATTR.link}="p2.2"]`))).toEqual({ unit: "p2", link: 2 });
	});

	it("reads through text nodes and italics", () => {
		const italic = q("em").firstElementChild?.firstChild ?? null;
		expect(italic?.nodeType).toBe(Node.TEXT_NODE);
		expect(stopFromTarget(italic)).toEqual({ unit: "p1", link: 2 });
	});

	it("reads a footnote ref carrying its sentence's link", () => {
		expect(stopFromTarget(q(".footnote-ref a"))).toEqual({ unit: "p1", link: 2 });
	});

	it("falls back to the unit for a whole unit or the gap between fragments", () => {
		expect(stopFromTarget(q("li"))).toEqual({ unit: "p3", link: null });
		const gap = q(`[${ATTR.unit}="p2"]`).childNodes[1] ?? null;
		expect(gap?.textContent).toBe(" ");
		expect(stopFromTarget(gap)).toEqual({ unit: "p2", link: null });
	});

	it("returns null outside units and for non-nodes", () => {
		expect(stopFromTarget(root)).toBeNull();
		expect(stopFromTarget(null)).toBeNull();
		expect(stopFromTarget(window)).toBeNull();
	});

	it("returns null inside a gloss or ghost card, whose clones are not stops", () => {
		const gloss = h("span", { class: CLS.gloss }, h("span", { [ATTR.unit]: "p3" }, "Clone"));
		const ghost = h("span", { class: CLS.ghost }, "EN p2.1");
		q(`[${ATTR.unit}="p2"]`).append(gloss, ghost);
		expect(stopFromTarget(gloss.firstChild)).toBeNull();
		expect(stopFromTarget(ghost.firstChild)).toBeNull();
	});

	it("rejects a malformed link", () => {
		expect(stopFromTarget(h("span", { [ATTR.link]: "p1" }))).toBeNull();
	});
});

describe("queries", () => {
	it("collects every fragment of a link crossing italics, with its footnote ref", () => {
		expect(linkFragments(root, { unit: "p1", link: 2 }).map((el) => el.tagName)).toEqual(["SPAN", "SPAN", "SPAN", "SUP"]);
		expect(linkFragments(root, { unit: "p1", link: null })).toEqual([]);
	});

	it("falls back to the unit element when a link has no fragments", () => {
		expect(stopElements(root, { unit: "p4", link: 2 }).map((el) => el.getAttribute(ATTR.unit))).toEqual(["p4"]);
	});

	it("includes the root itself", () => {
		const unit = q(`[${ATTR.unit}="p2"]`);
		expect(queryAll(unit, `[${ATTR.unit}]`)).toEqual([unit]);
	});

	it("skips clones inside a gloss or ghost card", () => {
		const p3 = q(`[${ATTR.unit}="p3"]`);
		p3.after(h("span", { class: CLS.gloss }, h("ul", { [ATTR.unit]: "p3" }, h("li", {}, "Clone"))));
		q(`[${ATTR.link}="p2.1"]`).after(h("span", { class: CLS.ghost }, h("span", { [ATTR.link]: "p2.1" }, "Clone")));
		expect(stopElements(root, { unit: "p3", link: null })).toEqual([p3]);
		expect(linkFragments(root, { unit: "p2", link: 1 })).toEqual([q(`[${ATTR.link}="p2.1"]`)]);
	});

	it("finds footnote units by their fn: key", () => {
		root.append(h("li", { [ATTR.unit]: "fn:en-1" }, "Cf. Ruiz, op. cit., p. 22."));
		expect(stopElements(root, { unit: "fn:en-1", link: null })).toHaveLength(1);
	});
});

describe("attachPointer", () => {
	let owner: Component;
	let jump: ReturnType<typeof vi.fn<(stop: CursorStop) => void>>;
	let hover: ReturnType<typeof vi.fn<(stop: CursorStop | null) => void>>;
	let hoverEnabled = true;

	beforeEach(() => {
		owner = new Component();
		owner.load();
		jump = vi.fn();
		hover = vi.fn();
		hoverEnabled = true;
		attachPointer(owner, root, { jump, hover, hoverEnabled: () => hoverEnabled });
	});
	afterEach(() => {
		owner.unload();
		vi.useRealTimers();
	});

	const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1, ...init }));
	const over = (el: Element, pointerType = "mouse") => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType }));

	it("jumps on a single click", () => {
		click(q(`[${ATTR.link}="p2.1"]`));
		expect(jump).toHaveBeenCalledWith({ unit: "p2", link: 1 });
	});

	it("does not jump on a link, internal link or footnote ref", () => {
		click(q(".internal-link"));
		click(q(".footnote-ref a"));
		click(q(".footnote-ref"));
		expect(jump).not.toHaveBeenCalled();
	});

	it("does not jump on a button or input inside a unit", () => {
		const unit = q(`[${ATTR.unit}="p4"]`);
		const button = h("button", {}, "Copiar");
		const input = h("input");
		unit.append(button, input);
		click(button);
		click(input);
		expect(jump).not.toHaveBeenCalled();
	});

	it("does not jump when text is selected", () => {
		const text = q(`[${ATTR.link}="p2.2"]`).firstChild as Text;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 4);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		click(q(`[${ATTR.link}="p2.2"]`));
		expect(jump).not.toHaveBeenCalled();
		selection?.removeAllRanges();
		click(q(`[${ATTR.link}="p2.2"]`));
		expect(jump).toHaveBeenCalledTimes(1);
	});

	it("does not jump on a double click or another button", () => {
		click(q(`[${ATTR.link}="p2.2"]`), { detail: 2 });
		click(q(`[${ATTR.link}="p2.2"]`), { button: 1 });
		expect(jump).not.toHaveBeenCalled();
	});

	it("hovers after a 120 ms dwell, mouse only", () => {
		vi.useFakeTimers();
		over(q(`[${ATTR.link}="p1.1"]`));
		vi.advanceTimersByTime(100);
		expect(hover).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20);
		expect(hover).toHaveBeenCalledWith({ unit: "p1", link: 1 });

		over(q(`[${ATTR.link}="p2.1"]`), "touch");
		over(q(`[${ATTR.link}="p2.1"]`), "pen");
		vi.advanceTimersByTime(500);
		expect(hover).toHaveBeenCalledTimes(1);
	});

	it("cancels a dwell the pointer left, and ignores gaps between fragments", () => {
		vi.useFakeTimers();
		over(q(`[${ATTR.link}="p2.1"]`));
		vi.advanceTimersByTime(60);
		over(q(`[${ATTR.link}="p2.2"]`));
		vi.advanceTimersByTime(60);
		expect(hover).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60);
		expect(hover).toHaveBeenLastCalledWith({ unit: "p2", link: 2 });

		over(q(`[${ATTR.unit}="p2"]`));
		vi.advanceTimersByTime(500);
		expect(hover).toHaveBeenCalledTimes(1);
	});

	it("clears hover when the pointer leaves the units or the pane", () => {
		vi.useFakeTimers();
		over(q(`[${ATTR.link}="p2.1"]`));
		vi.advanceTimersByTime(120);
		over(root);
		expect(hover).toHaveBeenLastCalledWith(null);
		over(q(`[${ATTR.link}="p2.1"]`));
		vi.advanceTimersByTime(120);
		root.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
		expect(hover).toHaveBeenLastCalledWith(null);
		expect(hover).toHaveBeenCalledTimes(4);
	});

	it("keeps the hover when the pointer reaches its ghost card, and never jumps from a gloss", () => {
		vi.useFakeTimers();
		over(q(`[${ATTR.link}="p2.1"]`));
		vi.advanceTimersByTime(120);
		const ghost = h("span", { class: CLS.ghost }, "EN p2.1");
		const gloss = h("span", { class: CLS.gloss }, "EN p2.2");
		q(`[${ATTR.link}="p2.1"]`).after(ghost, gloss);
		over(ghost);
		vi.advanceTimersByTime(500);
		expect(hover).toHaveBeenCalledTimes(1);
		click(gloss);
		expect(jump).not.toHaveBeenCalled();
	});

	it("does nothing while hover is off", () => {
		vi.useFakeTimers();
		hoverEnabled = false;
		over(q(`[${ATTR.link}="p2.1"]`));
		vi.advanceTimersByTime(500);
		expect(hover).not.toHaveBeenCalled();
	});
});
