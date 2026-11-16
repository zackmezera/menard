// @vitest-environment happy-dom
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { PairSession } from "../../src/reader/session";
import type { CursorStop } from "../../src/types";
import type { SessionHost } from "../../src/reader/session";
import type { FakeEnv, FakeLeaf } from "./fakes";
import {
	DEFAULT_UNITS,
	facingLeaves,
	fakeEnv,
	fakeModel,
	frag,
	installObsidianDom,
	layout,
	marked,
	section,
	settle,
	SOURCE_PATH,
	spanishSections,
	TARGET_PATH,
	unitEl,
} from "./fakes";

beforeAll(installObsidianDom);

let env: FakeEnv;
let source: FakeLeaf;
let target: FakeLeaf;
let stacked: Set<FakeLeaf>;
let revealMode: boolean;
let session: PairSession;
let positions: Map<string, CursorStop>;

function start(): void {
	const host: SessionHost = {
		leaves: (path) => env.workspace.leaves.filter((l) => l.view.file?.path === path) as unknown as WorkspaceLeaf[],
		isStacked: (leaf) => stacked.has(leaf as unknown as FakeLeaf),
		revealMode: () => revealMode,
		positions: { get: (path) => positions.get(path) ?? null, set: (path, stop) => void positions.set(path, stop) },
	};
	session = env.owner.addChild(new PairSession(SOURCE_PATH, TARGET_PATH, env.ctx, env.pairs, env.gloss, host));
	session.refresh();
}

beforeEach(() => {
	document.body.replaceChildren();
	env = fakeEnv();
	({ source, target } = facingLeaves(env));
	layout(target.view.scroller, 100);
	stacked = new Set();
	revealMode = false;
	positions = new Map();
	start();
});
afterEach(() => {
	env.owner.unload();
	vi.useRealTimers();
});

const src = () => source.view.content;
const tgt = () => target.view.content;
const link = (root: HTMLElement, attr: string) => Array.from(root.querySelectorAll<HTMLElement>(`[${ATTR.link}="${attr}"]`));
const unit = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`[${ATTR.unit}="${key}"]`);

describe("mode", () => {
	it("is facing when both notes are visible in reading view in one window", () => {
		expect(session.mode()).toBe("facing");
	});

	it("is single when the translation is hidden, elsewhere, or being edited", () => {
		target.view.containerEl.setAttribute("hidden", "");
		expect(session.mode()).toBe("single");
		target.view.containerEl.removeAttribute("hidden");
		target.container = {};
		expect(session.mode()).toBe("single");
		target.container = source.container;
		target.view.mode = "source";
		expect(session.mode()).toBe("single");
	});

	it("is stacked when the source leaf is flagged", () => {
		stacked.add(source);
		expect(session.mode()).toBe("stacked");
	});

	it("tags facing leaves and clears the tags on unload", () => {
		expect(source.view.containerEl.getAttribute(ATTR.role)).toBe("source");
		expect(target.view.containerEl.getAttribute(ATTR.role)).toBe("target");
		expect(target.view.containerEl.classList.contains(CLS.facing)).toBe(true);
		stacked.add(source);
		session.refresh();
		expect(source.view.containerEl.classList.contains(CLS.stacked)).toBe(true);
		expect(source.view.containerEl.hasAttribute(ATTR.role)).toBe(false);
		env.owner.removeChild(session);
		expect(source.view.containerEl.classList.contains(CLS.stacked)).toBe(false);
	});
});

describe("paint", () => {
	it("marks the current link and its partner in the other pane", async () => {
		await session.setCursor({ unit: "p1", link: 2 });
		expect(marked(src(), CLS.current)).toEqual(["p1.2", "p1.2", "p1.2", "p1.2"]);
		expect(marked(tgt(), CLS.partner)).toEqual(["p1.2", "p1.2", "p1.2"]);
		expect(marked(src(), CLS.partner)).toEqual([]);
		expect(marked(tgt(), CLS.current)).toEqual([]);
		expect(link(src(), "p1.2").every((el) => el.getAttribute("aria-current") === "true")).toBe(true);
		expect(session.state()).toEqual({ cursor: { unit: "p1", link: 2 }, hover: null, revealed: false });
	});

	it("toggles only the attributes that change", async () => {
		await session.setCursor({ unit: "p1", link: 2 });
		session.setHover({ unit: "p2", link: 1 });
		const changed = new Set<string>();
		const observer = new MutationObserver((records) => {
			for (const r of records) changed.add(`${(r.target as Element).getAttribute(ATTR.link) ?? "?"}:${r.attributeName ?? ""}`);
		});
		for (const root of [src(), tgt()]) observer.observe(root, { attributes: true, subtree: true });
		await session.setCursor({ unit: "p1", link: 3 });
		await settle();
		const records = [...changed].sort();
		observer.disconnect();
		expect(records).toEqual(["p1.2:aria-current", "p1.2:class", "p1.3:aria-current", "p1.3:class"]);
		expect(marked(src(), CLS.hover)).toEqual(["p2.1"]);
	});

	it("highlights the unit for a whole-unit stop", async () => {
		await session.setCursor({ unit: "p3", link: null });
		expect(unit(src(), "p3")?.classList.contains(CLS.unitCurrent)).toBe(true);
		expect(unit(src(), "p3")?.getAttribute("aria-current")).toBe("true");
		expect(unit(tgt(), "p3")?.classList.contains(CLS.unitPartner)).toBe(true);
		await session.setCursor({ unit: "p1", link: 1 });
		expect(unit(src(), "p3")?.classList.contains(CLS.unitCurrent)).toBe(false);
		expect(unit(src(), "p3")?.hasAttribute("aria-current")).toBe(false);
	});

	it("falls back to the unit when a link's spans are missing", async () => {
		env.pairs.model = fakeModel(DEFAULT_UNITS.map((u) => (u.key === "p4" ? { ...u, links: 2 } : u)));
		await session.setCursor({ unit: "p4", link: 2 });
		expect(unit(src(), "p4")?.classList.contains(CLS.unitCurrent)).toBe(true);
		expect(unit(tgt(), "p4")?.classList.contains(CLS.unitPartner)).toBe(true);
	});

	it("marks hover on both sides without moving the cursor", async () => {
		await session.setCursor({ unit: "p1", link: 1 });
		session.setHover({ unit: "p2", link: 2 });
		expect(marked(src(), CLS.hover)).toEqual(["p2.2"]);
		expect(marked(tgt(), CLS.hover)).toEqual(["p2.2"]);
		expect(session.state().cursor).toEqual({ unit: "p1", link: 1 });
		session.setHover(null);
		expect(marked(src(), CLS.hover)).toEqual([]);
	});

	it("ignores a jump to a link that is not a stop", async () => {
		await session.setCursor({ unit: "p1", link: 9 });
		expect(session.state().cursor).toBeNull();
	});

	it("clears every mark", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		await session.setCursor(null);
		expect(marked(src(), CLS.current)).toEqual([]);
		expect(marked(tgt(), CLS.partner)).toEqual([]);
	});

	it("leaves a pane in editing mode alone", async () => {
		target.view.mode = "source";
		await session.setCursor({ unit: "p2", link: 1 });
		expect(marked(tgt(), CLS.partner)).toEqual([]);
		expect(marked(src(), CLS.current)).toEqual(["p2.1"]);
	});
});

describe("sectionRendered", () => {
	it("repaints a section that reading view re-created", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		const old = unit(src(), "p2")?.parentElement;
		const fresh = section(unitEl("p", "p2", frag("p2.1", "El narrador, i. e. el reseñista, finge una edición."), " ", frag("p2.2", "Nada sabemos.")));
		old?.replaceWith(fresh);
		expect(marked(src(), CLS.current)).toEqual([]);
		session.sectionRendered(SOURCE_PATH, fresh);
		expect(marked(src(), CLS.current)).toEqual(["p2.1"]);
		expect(marked(fresh, CLS.partner)).toEqual([]);
	});

	it("paints a translation section with the partner class", async () => {
		await session.setCursor({ unit: "p3", link: null });
		const fresh = section(unitEl("ul", "p3"));
		session.sectionRendered(TARGET_PATH, fresh);
		expect(fresh.firstElementChild?.classList.contains(CLS.unitPartner)).toBe(true);
	});
});

describe("held level", () => {
	it("leaves the current pane alone inside the comfort band and levels the partner", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		// Source p2.1 at y 240 (inside 220–620); target p2.1 at doc 340.
		expect(source.view.scroller.el.scrollTop).toBe(0);
		expect(target.view.scroller.el.scrollTop).toBe(100);
		expect(target.view.scroller.scrollTo).toHaveBeenCalledWith({ top: 100, behavior: "smooth" });
	});

	it("moves the current sentence to the reading line when it leaves the band", async () => {
		await session.setCursor({ unit: "p4", link: null });
		// Source p4 at y 720: to the reading line (350). Target p4 at doc 820 goes level with it.
		expect(source.view.scroller.el.scrollTop).toBe(370);
		expect(target.view.scroller.el.scrollTop).toBe(470);
	});

	it("levels a link that lives in the second paragraph of a merged unit (ADR 0010)", async () => {
		// The translation renders source p2 as two paragraphs, both tagged p2; p2.2 is the second one, at doc 580.
		const first = unit(tgt(), "p2");
		if (!first) throw new Error("no p2");
		for (const el of link(tgt(), "p2.2")) el.remove();
		first.parentElement?.after(section(unitEl("p", "p2", frag("p2.2", "We know nothing of Dr. Bahadur."))));
		layout(target.view.scroller, 100);
		await session.setCursor({ unit: "p2", link: 2 });
		// Source p2.2 at y 288 stays; target p2.2 at doc 580 goes level with it.
		expect(source.view.scroller.el.scrollTop).toBe(0);
		expect(target.view.scroller.el.scrollTop).toBe(292);
		expect(link(tgt(), "p2.2")[0]?.parentElement?.previousElementSibling).toBeNull();
		expect(marked(tgt(), CLS.partner)).toEqual(["p2.2"]);
	});

	it("scrolls instantly on key repeat", async () => {
		await session.setCursor({ unit: "p2", link: 1 }, { repeat: true });
		expect(target.view.scroller.scrollTo).not.toHaveBeenCalled();
		expect(target.view.scroller.el.scrollTop).toBe(100);
	});

	it("scrolls instantly under prefers-reduced-motion", async () => {
		window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia;
		await session.setCursor({ unit: "p2", link: 1 });
		window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
		expect(target.view.scroller.scrollTo).not.toHaveBeenCalled();
		expect(target.view.scroller.el.scrollTop).toBe(100);
	});

	it("jumps long distances instantly", async () => {
		source.view.scroller.el.scrollTop = 0;
		target.view.scroller.el.scrollTop = 3000;
		await session.setCursor({ unit: "p2", link: 1 });
		expect(target.view.scroller.scrollTo).not.toHaveBeenCalled();
		expect(target.view.scroller.el.scrollTop).toBe(100);
	});
});

describe("unrendered stops", () => {
	it("scrolls by line and waits for the section", async () => {
		const p5 = (side: "source" | "target") =>
			section(unitEl("p", "p5", frag("p5.1", side === "source" ? "Coda: «sin fin»." : "Coda: “endless.”"), " ", frag("p5.2", "Fin.")));
		source.view.applyScroll.mockImplementation(() => {
			const el = p5("source");
			queueMicrotask(() => {
				source.view.sizer().append(el);
				layout(source.view.scroller);
				session.sectionRendered(SOURCE_PATH, el);
			});
		});
		target.view.applyScroll.mockImplementation(() => {
			const el = p5("target");
			queueMicrotask(() => {
				target.view.sizer().append(el);
				layout(target.view.scroller, 100);
				session.sectionRendered(TARGET_PATH, el);
			});
		});
		await session.setCursor({ unit: "p5", link: 1 });
		expect(source.view.applyScroll).toHaveBeenCalledWith(400);
		expect(target.view.applyScroll).toHaveBeenCalledWith(420);
		expect(marked(src(), CLS.current)).toEqual(["p5.1"]);
		expect(marked(tgt(), CLS.partner)).toEqual(["p5.1"]);
		// Source p5 at doc 960 is below the band: to the reading line; target p5 at 1060 level with it.
		expect(source.view.scroller.el.scrollTop).toBe(610);
		expect(target.view.scroller.el.scrollTop).toBe(710);
	});

	it("gives up waiting after one second and keeps the coarse position", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const done = session.setCursor({ unit: "p5", link: 1 });
		await settle();
		vi.advanceTimersByTime(1000);
		await done;
		expect(session.state().cursor).toEqual({ unit: "p5", link: 1 });
		expect(source.view.scroller.el.scrollTop).toBe(0);
	});
});

describe("step", () => {
	it("enters at the reading line when there is no cursor", async () => {
		// Reading line at doc 350: p1 and p2's fragments are above it; p3 is the first stop that reaches it.
		await session.step("link", 1);
		expect(session.state().cursor).toEqual({ unit: "p3", link: null });
	});

	it("steps by link and by unit from an on-screen cursor", async () => {
		await session.setCursor({ unit: "p1", link: 1 });
		await session.step("link", 1);
		expect(session.state().cursor).toEqual({ unit: "p1", link: 2 });
		await session.step("unit", 1);
		expect(session.state().cursor).toEqual({ unit: "p2", link: 1 });
		await session.step("unit", -1);
		expect(session.state().cursor).toEqual({ unit: "p1", link: 1 });
		await session.step("link", -1);
		expect(session.state().cursor).toEqual({ unit: "p1", link: 1 });
	});

	it("re-enters at the reading line when the reader scrolled the cursor away", async () => {
		await session.setCursor({ unit: "p1", link: 1 });
		source.view.scroller.el.scrollTop = 200;
		await session.step("link", 1);
		expect(session.state().cursor).toEqual({ unit: "p3", link: null });
	});
});

describe("stacked view", () => {
	beforeEach(() => {
		stacked.add(source);
		session.refresh();
	});
	const gloss = () => src().querySelector<HTMLElement>(`.${CLS.gloss}`);

	it("shows the gloss under the current link and moves it with the cursor", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		expect(gloss()?.textContent).toBe("EN p2.1");
		await session.setCursor({ unit: "p2", link: 2 });
		expect(src().querySelectorAll(`.${CLS.gloss}`)).toHaveLength(1);
		expect(gloss()?.previousElementSibling?.getAttribute(ATTR.link)).toBe("p2.2");
	});

	it("reveals a concealed gloss, and conceals again on any move", async () => {
		revealMode = true;
		await session.setCursor({ unit: "p2", link: 1 });
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(true);
		expect(session.canReveal()).toBe(true);
		expect(session.reveal()).toBe(true);
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(false);
		expect(session.state().revealed).toBe(true);
		expect(session.reveal()).toBe(false);
		await session.setCursor({ unit: "p2", link: 2 });
		expect(session.state().revealed).toBe(false);
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(true);
	});

	it("does not reveal outside reveal mode", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		expect(session.reveal()).toBe(false);
	});

	it("shows a ghost card on hover, only with reveal mode off", async () => {
		await session.setCursor({ unit: "p1", link: 1 });
		session.setHover({ unit: "p2", link: 2 });
		await settle();
		expect(src().querySelector(`.${CLS.ghost}`)?.textContent).toBe("EN p2.2");
		session.setHover(null);
		expect(src().querySelector(`.${CLS.ghost}`)).toBeNull();
		revealMode = true;
		session.setHover({ unit: "p2", link: 2 });
		await settle();
		expect(src().querySelector(`.${CLS.ghost}`)).toBeNull();
	});

	it("puts the gloss back when its section is re-created", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		const fresh = spanishSections()[1];
		if (!fresh) throw new Error("no section");
		unit(src(), "p2")?.parentElement?.replaceWith(fresh);
		expect(gloss()).toBeNull();
		session.sectionRendered(SOURCE_PATH, fresh);
		await settle();
		expect(gloss()?.previousElementSibling?.getAttribute(ATTR.link)).toBe("p2.1");
	});

	it("keeps a revealed gloss through a rebuild that keeps the cursor, and conceals when the rebuild moves it", async () => {
		revealMode = true;
		await session.setCursor({ unit: "p1", link: 3 });
		session.reveal();
		env.pairs.model = fakeModel(DEFAULT_UNITS, 2);
		session.modelChanged();
		expect(session.state().revealed).toBe(true);
		env.pairs.model = fakeModel(DEFAULT_UNITS.map((u) => (u.key === "p1" ? { ...u, links: 1 } : u)), 3);
		session.modelChanged();
		await settle();
		expect(session.state()).toMatchObject({ cursor: { unit: "p1", link: 1 }, revealed: false });
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(true);
	});

	it("removes the gloss when the view leaves stacked mode", async () => {
		await session.setCursor({ unit: "p2", link: 1 });
		stacked.clear();
		session.refresh();
		expect(gloss()).toBeNull();
	});
});

describe("model rebuild", () => {
	it("keeps the cursor on the unit when its link disappeared", async () => {
		await session.setCursor({ unit: "p1", link: 3 });
		env.pairs.model = fakeModel(DEFAULT_UNITS.map((u) => (u.key === "p1" ? { ...u, links: 1 } : u)), 2);
		session.modelChanged();
		expect(session.state().cursor).toEqual({ unit: "p1", link: 1 });
		expect(marked(src(), CLS.current)).toEqual(["p1.1"]);
	});
});

describe("pointer wiring", () => {
	it("jumps on click in either pane", async () => {
		link(tgt(), "p2.2")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
		await settle();
		expect(session.state().cursor).toEqual({ unit: "p2", link: 2 });
	});
});

describe("the pane the reader works in leads", () => {
	it("keeps a sentence clicked in the translation pane in place, marks it current, and levels the source", async () => {
		link(tgt(), "p2.1")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
		await settle(50);
		expect(session.state().cursor).toEqual({ unit: "p2", link: 1 });
		// Target p2.1 sits at y 340, inside the comfort band: that pane stays; the source follows.
		expect(target.view.scroller.el.scrollTop).toBe(0);
		expect(marked(tgt(), CLS.current)).toEqual(["p2.1"]);
		expect(link(tgt(), "p2.1")[0]?.getAttribute("aria-current")).toBe("true");
		expect(marked(src(), CLS.partner)).toEqual(["p2.1"]);
		expect(marked(src(), CLS.current)).toEqual([]);
	});

	it("leads with the source again after a click there", async () => {
		link(tgt(), "p2.1")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
		await settle(50);
		link(src(), "p2.2")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
		await settle(50);
		expect(marked(src(), CLS.current)).toEqual(["p2.2"]);
		expect(marked(tgt(), CLS.partner)).toEqual(["p2.2"]);
		expect(marked(tgt(), CLS.current)).toEqual([]);
	});
});

describe("reveal while the gloss renders", () => {
	it("shows the gloss when Space came before the render finished", async () => {
		stacked.add(source);
		session.refresh();
		revealMode = true;
		const render = env.gloss.render.bind(env.gloss);
		let release = (): void => {};
		env.gloss.render = (...args) =>
			new Promise((resolve) => {
				release = () => resolve(render(...args));
			});
		const moving = session.setCursor({ unit: "p2", link: 1 });
		await settle();
		expect(session.reveal()).toBe(true);
		release();
		await moving;
		const gloss = src().querySelector<HTMLElement>(`.${CLS.gloss}`);
		expect(gloss?.textContent).toBe("EN p2.1");
		expect(gloss?.classList.contains(CLS.concealed)).toBe(false);
	});
});

describe("restoring the reading cursor", () => {
	it("records every cursor stop for the source note", async () => {
		await session.setCursor({ unit: "p1", link: 2 });
		await session.setCursor({ unit: "p3", link: null });
		await session.setCursor(null);
		expect(positions.get(SOURCE_PATH)).toEqual({ unit: "p3", link: null });
	});

	it("puts the cursor back on the recorded stop and scrolls it into view", async () => {
		positions.set(SOURCE_PATH, { unit: "p4", link: null });
		expect(await session.restore()).toBe(true);
		expect(session.state().cursor).toEqual({ unit: "p4", link: null });
		expect(unit(src(), "p4")?.classList.contains(CLS.unitCurrent)).toBe(true);
		expect(unit(tgt(), "p4")?.classList.contains(CLS.unitPartner)).toBe(true);
		// As for any move out of the comfort band: p4 to the reading line, the partner level with it.
		expect(source.view.scroller.el.scrollTop).toBe(370);
		expect(target.view.scroller.el.scrollTop).toBe(470);
		expect(source.view.scroller.scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
	});

	it("restores into the stacked view", async () => {
		stacked.add(source);
		session.refresh();
		positions.set(SOURCE_PATH, { unit: "p2", link: 1 });
		expect(await session.restore()).toBe(true);
		await settle();
		expect(session.mode()).toBe("stacked");
		expect(marked(src(), CLS.current)).toContain("p2.1");
		expect(src().querySelector(`.${CLS.gloss}`)).not.toBeNull();
	});

	it("ignores a recorded stop that no longer resolves", async () => {
		positions.set(SOURCE_PATH, { unit: "p1", link: 9 });
		expect(await session.restore()).toBe(false);
		positions.set(SOURCE_PATH, { unit: "gone", link: null });
		expect(await session.restore()).toBe(false);
		expect(session.state().cursor).toBeNull();
	});

	it("leaves a cursor the reader placed while it was loading", async () => {
		positions.set(SOURCE_PATH, { unit: "p4", link: null });
		const restoring = session.restore();
		await session.setCursor({ unit: "p1", link: 1 });
		expect(await restoring).toBe(false);
		expect(session.state().cursor).toEqual({ unit: "p1", link: 1 });
	});
});
