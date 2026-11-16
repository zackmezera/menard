// @vitest-environment happy-dom
import type { WorkspaceLeaf } from "obsidian";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { findLeaf, markdownFile, openFacingView, readingPane, scrollerBox, tagFacing, tagStacked } from "../../src/reader/facing";
import type { FakeEnv } from "./fakes";
import { englishSections, fakeEnv, h, installObsidianDom, spanishSections } from "./fakes";

beforeAll(installObsidianDom);

let env: FakeEnv;
beforeEach(() => {
	document.body.replaceChildren();
	env = fakeEnv();
});

const asLeaf = (leaf: unknown) => leaf as WorkspaceLeaf;

describe("readingPane", () => {
	it("exposes a reading view's content, scroller and line scrolling", () => {
		const leaf = env.workspace.addLeaf(env.pairs.source, spanishSections());
		const pane = readingPane(asLeaf(leaf));
		expect(pane?.path).toBe(env.pairs.source.path);
		expect(pane?.content).toBe(leaf.view.content);
		expect(pane?.scroller).toBe(leaf.view.scroller.el);
		expect(pane?.visible()).toBe(true);
		pane?.applyScroll(14);
		expect(leaf.view.applyScroll).toHaveBeenCalledWith(14);
	});

	it("is null in editing mode, without a file, or for other views", () => {
		const editing = env.workspace.addLeaf(env.pairs.source, []);
		editing.view.mode = "source";
		expect(readingPane(asLeaf(editing))).toBeNull();
		expect(markdownFile(asLeaf(editing))?.path).toBe(env.pairs.source.path);
		expect(readingPane(asLeaf(env.workspace.addLeaf(null, [])))).toBeNull();
		expect(readingPane(asLeaf({ view: {} }))).toBeNull();
		expect(markdownFile(asLeaf({ view: {} }))).toBeNull();
	});

	it("measures a scroller", () => {
		const leaf = env.workspace.addLeaf(env.pairs.source, spanishSections());
		leaf.view.scroller.el.scrollTop = 120;
		expect(scrollerBox(leaf.view.scroller.el)).toEqual({ scrollTop: 120, top: 0, height: 1000, scrollHeight: 10000 });
	});
});

describe("tags", () => {
	it("sets and clears the facing role and class, and the stacked class", () => {
		const el = h("div");
		tagFacing(el, "target");
		expect(el.getAttribute(ATTR.role)).toBe("target");
		expect(el.classList.contains(CLS.facing)).toBe(true);
		tagFacing(el, null);
		expect(el.hasAttribute(ATTR.role)).toBe(false);
		expect(el.classList.contains(CLS.facing)).toBe(false);
		tagStacked(el, true);
		expect(el.classList.contains(CLS.stacked)).toBe(true);
		tagStacked(el, false);
		expect(el.className).toBe("");
	});
});

describe("openFacingView", () => {
	it("splits right for the translation when no leaf shows it", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		await openFacingView(env.app, env.pairs.pair, asLeaf(source));
		expect(source.openFile).not.toHaveBeenCalled();
		expect(env.workspace.setActiveLeaf).toHaveBeenCalledWith(source, { focus: false });
		expect(env.workspace.split?.openFile).toHaveBeenCalledWith(env.pairs.target, { state: { mode: "preview" }, active: false });
	});

	it("reuses a leaf in the same window that shows the translation, switching it to reading view", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		const target = env.workspace.addLeaf(env.pairs.target, englishSections());
		target.view.mode = "source";
		await openFacingView(env.app, env.pairs.pair, asLeaf(source));
		expect(env.workspace.getLeaf).not.toHaveBeenCalled();
		expect(target.openFile).toHaveBeenCalledWith(env.pairs.target, { state: { mode: "preview" }, active: false });
		expect(target.view.mode).toBe("preview");
	});

	it("leaves a translation already in reading view untouched", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		const target = env.workspace.addLeaf(env.pairs.target, englishSections());
		await openFacingView(env.app, env.pairs.pair, asLeaf(source));
		expect(target.openFile).not.toHaveBeenCalled();
	});

	it("puts the source in the current leaf when started from the translation", async () => {
		const current = env.workspace.addLeaf(env.pairs.target, englishSections());
		await openFacingView(env.app, env.pairs.pair, asLeaf(current));
		expect(current.openFile).toHaveBeenCalledWith(env.pairs.source, { state: { mode: "preview" } });
		expect(current.view.file?.path).toBe(env.pairs.source.path);
		expect(env.workspace.split?.openFile).toHaveBeenCalledWith(env.pairs.target, { state: { mode: "preview" }, active: false });
	});

	it("switches the source leaf to reading view", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		source.view.mode = "source";
		await openFacingView(env.app, env.pairs.pair, asLeaf(source));
		expect(source.view.mode).toBe("preview");
	});

	it("does not reuse a translation leaf in another window", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		env.workspace.addLeaf(env.pairs.target, englishSections(), {});
		await openFacingView(env.app, env.pairs.pair, asLeaf(source));
		expect(env.workspace.getLeaf).toHaveBeenCalledWith("split", "vertical");
	});

	it("finds the first matching leaf", () => {
		const a = env.workspace.addLeaf(env.pairs.source, []);
		env.workspace.addLeaf(env.pairs.source, []);
		expect(findLeaf(env.app, (l) => markdownFile(l)?.path === env.pairs.source.path)).toBe(a);
		expect(findLeaf(env.app, () => false)).toBeNull();
	});
});
