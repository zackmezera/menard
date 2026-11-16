// @vitest-environment happy-dom
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ATTR, CLS } from "../../src/constants";
import { ReadingPositions } from "../../src/reader/positions";
import { SessionManager } from "../../src/reader/sessions";
import type { FakeEnv, FakeLeaf } from "./fakes";
import { DEFAULT_UNITS, englishSections, facingLeaves, fakeEnv, fakeFile, fakeModel, installObsidianDom, marked, settle, SOURCE_PATH, spanishSections } from "./fakes";

beforeAll(installObsidianDom);

let env: FakeEnv;
let manager: SessionManager;

const asLeaf = (leaf: FakeLeaf) => leaf as unknown as WorkspaceLeaf;
const press = (key: string, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	document.body.dispatchEvent(event);
	return event;
};

beforeEach(() => {
	document.body.replaceChildren();
	env = fakeEnv();
	manager = new SessionManager(env.ctx, env.pairs, env.gloss);
});
afterEach(() => env.owner.unload());

describe("SessionManager lifecycle", () => {
	it("has no session until a pair note is in reading view", () => {
		manager.start();
		expect(manager.hasActiveSession()).toBe(false);
		expect(manager.step("link", 1)).toBe(false);
		expect(manager.currentUnit()).toBeNull();
		expect(manager.clearCursor()).toBe(false);
		expect(manager.reveal()).toBe(false);
	});

	it("creates a session on layout-change and disposes it when the leaves go", async () => {
		manager.start();
		const { source } = facingLeaves(env);
		env.workspace.trigger("layout-change");
		expect(manager.hasActiveSession()).toBe(true);
		expect(source.view.containerEl.classList.contains(CLS.facing)).toBe(true);

		expect(manager.step("link", 1)).toBe(true);
		await settle();
		expect(marked(source.view.content, CLS.unitCurrent)).toEqual(["p3"]);

		// The translation leaf closes; the source leaf moves on to another note.
		env.workspace.leaves.splice(1);
		source.view.file = fakeFile("Collections/Texts/@otro.md");
		env.workspace.trigger("layout-change");
		expect(manager.hasActiveSession()).toBe(false);
		expect(source.view.containerEl.classList.contains(CLS.facing)).toBe(false);
		expect(source.view.containerEl.hasAttribute(ATTR.role)).toBe(false);
	});

	it("keeps the session while a note is being edited, and ignores other notes", async () => {
		const { source, target } = facingLeaves(env);
		manager.start();
		manager.step("unit", 1);
		await settle();
		source.view.mode = "source";
		target.view.mode = "source";
		env.workspace.trigger("active-leaf-change");
		expect(manager.hasActiveSession()).toBe(true);
		expect(manager.currentUnit()?.key).toBeDefined();

		const other = env.workspace.addLeaf(null, []);
		env.workspace.active = other;
		env.workspace.trigger("file-open");
		expect(manager.hasActiveSession()).toBe(false);
	});

	it("answers commands for the active session", async () => {
		facingLeaves(env);
		manager.start();
		expect(manager.step("link", 1)).toBe(true);
		await settle();
		const current = manager.currentUnit();
		expect(current?.key).toBe("p3");
		expect(current?.pair.source.path).toBe(SOURCE_PATH);
		expect(manager.clearCursor()).toBe(true);
		await settle();
		expect(manager.currentUnit()).toBeNull();
	});

	it("routes rendered sections by path", async () => {
		const { source } = facingLeaves(env);
		manager.start();
		manager.step("link", 1);
		await settle();
		const fresh = spanishSections()[2];
		if (!fresh) throw new Error("no section");
		source.view.content.querySelector(`[${ATTR.unit}="p3"]`)?.parentElement?.replaceWith(fresh);
		manager.sectionRendered("Collections/Texts/other.md", fresh);
		expect(fresh.firstElementChild?.classList.contains(CLS.unitCurrent)).toBe(false);
		manager.sectionRendered(SOURCE_PATH, fresh);
		expect(fresh.firstElementChild?.classList.contains(CLS.unitCurrent)).toBe(true);
	});

	it("repaints when the pair's model is rebuilt", async () => {
		const { source } = facingLeaves(env);
		manager.start();
		manager.step("link", 1);
		await settle();
		env.pairs.rebuild(fakeModel(DEFAULT_UNITS.filter((u) => u.key !== "p3"), 2));
		expect(manager.currentUnit()).toBeNull();
		expect(marked(source.view.content, CLS.unitCurrent)).toEqual([]);
	});
});

describe("stacked view and reveal", () => {
	it("toggles stacked view on a source leaf in reading view only", () => {
		const { source, target } = facingLeaves(env);
		manager.start();
		expect(manager.toggleStacked(asLeaf(target))).toBe(false);
		expect(manager.toggleStacked(asLeaf(source))).toBe(true);
		expect(source.view.containerEl.classList.contains(CLS.stacked)).toBe(true);
		expect(source.view.containerEl.classList.contains(CLS.facing)).toBe(false);
		expect(manager.toggleStacked(asLeaf(source))).toBe(true);
		expect(source.view.containerEl.classList.contains(CLS.stacked)).toBe(false);
		source.view.mode = "source";
		expect(manager.toggleStacked(asLeaf(source))).toBe(false);
	});

	it("toggles reveal mode only in stacked view, and Space reveals", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		env.workspace.active = source;
		manager.start();
		expect(manager.toggleRevealMode()).toBe(false);
		manager.toggleStacked(asLeaf(source));
		expect(manager.toggleRevealMode()).toBe(true);
		press("j");
		await settle(20);
		const gloss = () => source.view.content.querySelector(`.${CLS.gloss}`);
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(true);
		expect(press(" ").defaultPrevented).toBe(true);
		expect(gloss()?.classList.contains(CLS.concealed)).toBe(false);
		expect(press(" ").defaultPrevented).toBe(false);
	});

	it("follows the reveal-mode setting again once it changes after a toggle", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		env.workspace.active = source;
		manager.start();
		manager.toggleStacked(asLeaf(source));
		expect(manager.toggleRevealMode()).toBe(true);
		// The reader turns the setting on and off again; each change is saved.
		env.settings.revealMode = true;
		manager.settingsChanged();
		env.settings.revealMode = false;
		manager.settingsChanged();
		press("j");
		await settle(20);
		const gloss = source.view.content.querySelector(`.${CLS.gloss}`);
		expect(gloss?.classList.contains(CLS.concealed)).toBe(false);
		expect(manager.canReveal()).toBe(false);
	});

	it("offers reveal only in stacked view with a concealed gloss, and the toggle only in stacked view", async () => {
		manager.start();
		const { source } = facingLeaves(env);
		env.workspace.trigger("layout-change");
		expect(manager.hasActiveSession()).toBe(true);
		expect(manager.canReveal()).toBe(false);
		expect(manager.canToggleRevealMode()).toBe(false);
		manager.toggleStacked(asLeaf(source));
		expect(manager.canToggleRevealMode()).toBe(true);
	});
});

describe("reading keys", () => {
	it("step the active session and clear with Esc", async () => {
		const { source } = facingLeaves(env);
		manager.start();
		expect(press("Escape").defaultPrevented).toBe(false);
		expect(press("j").defaultPrevented).toBe(true);
		await settle();
		expect(press("ArrowRight", { shiftKey: true }).defaultPrevented).toBe(true);
		await settle();
		expect(manager.currentUnit()?.key).toBe("p4");
		expect(press("Escape").defaultPrevented).toBe(true);
		await settle();
		expect(marked(source.view.content, CLS.unitCurrent)).toEqual([]);
	});

	it("are inert while the active leaf is being edited", () => {
		const { source } = facingLeaves(env);
		manager.start();
		source.view.mode = "source";
		expect(press("j").defaultPrevented).toBe(false);
	});
});

describe("openFacing", () => {
	it("opens the translation to the right of the source and starts a facing session", async () => {
		const source = env.workspace.addLeaf(env.pairs.source, spanishSections());
		env.workspace.active = source;
		manager.start();
		await manager.openFacing(env.pairs.source);
		const split = env.workspace.split;
		expect(env.workspace.getLeaf).toHaveBeenCalledWith("split", "vertical");
		expect(split?.openFile).toHaveBeenCalledWith(env.pairs.target, { state: { mode: "preview" }, active: false });
		split?.view.sizer().append(...englishSections());
		env.workspace.trigger("layout-change");
		expect(split?.view.containerEl.getAttribute(ATTR.role)).toBe("target");
	});

	it("does nothing for a note outside a pair", async () => {
		manager.start();
		await manager.openFacing(fakeFile("Collections/Texts/@otro.md"));
		expect(env.workspace.getLeaf).not.toHaveBeenCalled();
	});
});

describe("SessionManager reading positions", () => {
	it("records the cursor and restores it when the pair is opened again", async () => {
		const positions = new ReadingPositions(() => {});
		manager = new SessionManager(env.ctx, env.pairs, env.gloss, positions);
		manager.start();
		const { source } = facingLeaves(env);
		env.workspace.trigger("layout-change");
		manager.step("unit", 1);
		await settle();
		manager.step("unit", 1);
		await settle();
		const saved = positions.get(SOURCE_PATH);
		expect(saved?.unit).toBe(manager.currentUnit()?.key);

		// Close the pair, then open it again: a fresh session starts where the last one stopped.
		const leaves = env.workspace.leaves.splice(0);
		env.workspace.trigger("layout-change");
		expect(manager.hasActiveSession()).toBe(false);
		env.workspace.leaves.push(...leaves);
		env.workspace.trigger("layout-change");
		await settle();
		await settle();
		expect(manager.currentUnit()?.key).toBe(saved?.unit);
		expect(marked(source.view.content, saved?.link === null ? CLS.unitCurrent : CLS.current)[0]).toBe(
			saved?.link === null ? saved.unit : `${saved?.unit}.${saved?.link}`,
		);
	});
});
