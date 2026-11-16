// @vitest-environment happy-dom
import { Component } from "obsidian";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTR } from "../../src/constants";
import { attachScrollSync, ScrollWriter } from "../../src/reader/scroll-sync";
import type { SyncPane } from "../../src/reader/scroll-sync";
import type { PairModel } from "../../src/types";
import type { FakeScroller } from "./fakes";
import { DEFAULT_UNITS, englishSections, fakeModel, fakeScroller, frag, h, installObsidianDom, layout, section, settle, spanishSections, unitEl } from "./fakes";

beforeAll(installObsidianDom);

let source: FakeScroller;
let target: FakeScroller;
let panes: [SyncPane, SyncPane];
let targetApplyScroll: ReturnType<typeof vi.fn<(line: number) => void>>;
let writer: ScrollWriter;
let owner: Component;
let model: PairModel;

function build(sourceStart: number, targetStart: number): void {
	source = fakeScroller(h("div", {}, ...spanishSections()));
	target = fakeScroller(h("div", {}, ...englishSections()));
	document.body.replaceChildren(source.el, target.el);
	layout(source, sourceStart);
	layout(target, targetStart);
	panes = [
		{ side: "source", scroller: source.el, applyScroll: vi.fn() },
		{ side: "target", scroller: target.el, applyScroll: (targetApplyScroll = vi.fn()) },
	];
	writer = new ScrollWriter();
	owner = new Component();
	owner.load();
	attachScrollSync(owner, panes, () => model, writer);
}

/** User input on a scroller, then a scroll to `top`. */
async function userScroll(scroller: FakeScroller, top: number, input = "wheel"): Promise<void> {
	scroller.el.dispatchEvent(new Event(input));
	scroller.el.scrollTop = top;
	scroller.el.dispatchEvent(new Event("scroll"));
	await settle();
}

beforeEach(() => {
	model = fakeModel();
	// Units are 200 px tall, 40 px apart. Reading line: client y 350.
	build(0, 100);
});
afterEach(() => {
	owner.unload();
	vi.useRealTimers();
});

describe("scroll sync", () => {
	it("places the partner so the same fraction sits at the reading line", async () => {
		// Source line at doc 400: 80% through p2 (240–440). Target p2 is 340–540, so 500 goes to y 350.
		await userScroll(source, 50);
		expect(target.el.scrollTop).toBe(150);
	});

	it("follows in either direction, driven by pointer, touch or keys", async () => {
		await userScroll(target, 150, "pointerdown");
		expect(source.el.scrollTop).toBe(50);
		await userScroll(target, 160, "touchstart");
		expect(source.el.scrollTop).toBe(60);
		target.el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
		target.el.scrollTop = 170;
		target.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(source.el.scrollTop).toBe(70);
	});

	it("ignores scrolls without user input", async () => {
		source.el.scrollTop = 50;
		source.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(target.el.scrollTop).toBe(0);
	});

	it("ignores the echo of its own scroll in the follower", async () => {
		await userScroll(source, 50);
		const sourceTop = source.el.scrollTop;
		target.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(source.el.scrollTop).toBe(sourceTop);
	});

	it("ignores the echo of an expected programmatic scrollTop in the driver", async () => {
		source.el.dispatchEvent(new Event("wheel"));
		writer.write(source.el, 300, false);
		source.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(target.el.scrollTop).toBe(0);

		source.el.scrollTop = 50;
		source.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(target.el.scrollTop).toBe(150);
	});

	it("ignores every frame of its own smooth scroll in the driver, as after a click-to-jump", async () => {
		source.el.dispatchEvent(new Event("pointerdown"));
		writer.write(source.el, 300, true);
		for (const top of [80, 190]) {
			source.el.scrollTop = top;
			source.el.dispatchEvent(new Event("scroll"));
			await settle();
		}
		expect(target.el.scrollTop).toBe(0);

		await userScroll(source, 50);
		expect(target.el.scrollTop).toBe(150);
	});

	it("drops the driver 150 ms after the last input", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		source.el.dispatchEvent(new Event("wheel"));
		vi.advanceTimersByTime(151);
		source.el.scrollTop = 50;
		source.el.dispatchEvent(new Event("scroll"));
		await settle();
		expect(target.el.scrollTop).toBe(0);
	});

	it("interpolates between paired units", async () => {
		owner.unload();
		build(300, 600);
		// Source line at doc 520: halfway through the 500–540 gap. Target gap 800–840: 820 goes to y 350.
		await userScroll(source, 170);
		expect(target.el.scrollTop).toBe(470);
	});

	it("parks the follower in an unpaired unit", async () => {
		model = fakeModel(DEFAULT_UNITS.map((u) => (u.key === "p3" ? { ...u, target: null } : u)));
		// Source line at doc 550: inside p3 (480–680), which has no partner.
		await userScroll(source, 200);
		expect(target.el.scrollTop).toBe(0);
	});

	it("scrolls an unrendered partner in by line, then corrects in pixels", async () => {
		const p2 = target.el.querySelector(`[${ATTR.unit}="p2"]`)?.parentElement;
		if (!p2) throw new Error("no p2");
		const sizer = target.el;
		p2.remove();
		targetApplyScroll.mockImplementation(() => {
			sizer.insertBefore(p2, sizer.children[1] ?? null);
			layout(target, 100);
		});
		await userScroll(source, 50);
		expect(targetApplyScroll).toHaveBeenCalledWith(17);
		expect(target.el.scrollTop).toBe(150);
	});

	it("measures a merged unit across all its paragraphs, in either pane (ADR 0010)", async () => {
		// The translation renders source p2 as two paragraphs, both tagged p2: 340–540 and 580–780 from y 100.
		const second = target.el.querySelector(`[${ATTR.unit}="p2"]`)?.parentElement;
		if (!second) throw new Error("no p2");
		second.after(section(unitEl("p", "p2", frag("p2.2", "We know nothing of Dr. Bahadur."))));
		layout(target, 100);
		// Source line at doc 400: 80% through p2 (240–440); 80% through 340–780 is doc 692, to y 350.
		await userScroll(source, 50);
		expect(target.el.scrollTop).toBe(342);
		// Target line at doc 670, in the second paragraph: 75% through p2, so source doc 390 goes to y 350.
		await userScroll(target, 320);
		expect(source.el.scrollTop).toBe(40);
	});

	it("stops listening on unload", async () => {
		owner.unload();
		await userScroll(source, 50);
		expect(target.el.scrollTop).toBe(0);
	});
});

describe("ScrollWriter", () => {
	it("recognizes its echo once, and forgets it when the user takes over", () => {
		const s = fakeScroller(h("div"));
		const w = new ScrollWriter();
		w.write(s.el, 400, false);
		expect(s.el.scrollTop).toBe(400);
		expect(w.isEcho(s.el)).toBe(true);
		expect(w.isEcho(s.el)).toBe(false);
		w.write(s.el, 500, true);
		expect(s.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "smooth" });
		s.el.scrollTop = 450;
		expect(w.isEcho(s.el)).toBe(true);
		w.forget(s.el);
		expect(w.isEcho(s.el)).toBe(false);
	});

	it("does not write a position the scroller already has", () => {
		const s = fakeScroller(h("div"));
		const w = new ScrollWriter();
		w.write(s.el, 0.5, true);
		expect(s.scrollTo).not.toHaveBeenCalled();
		expect(w.isEcho(s.el)).toBe(false);
	});
});
