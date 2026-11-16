// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Component } from "obsidian";
import { keyAction, registerReadingKeys } from "../../src/reader/keys";
import type { KeyAction, KeyContext, KeyLike } from "../../src/reader/keys";
import { fakeEnv, h, installObsidianDom } from "./fakes";

beforeAll(installObsidianDom);

const owners: Component[] = [];
afterEach(() => {
	for (const owner of owners.splice(0)) owner.unload();
});

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
	key: k,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	isComposing: false,
	...mods,
});
const plain: KeyContext = { revealable: false, hasCursor: false };
const full: KeyContext = { revealable: true, hasCursor: true };

describe("keyAction (§9.7 table)", () => {
	it.each([
		[key("j"), "next"],
		[key("ArrowRight"), "next"],
		[key("k"), "previous"],
		[key("ArrowLeft"), "previous"],
		[key("J", { shiftKey: true }), "next-unit"],
		[key("ArrowRight", { shiftKey: true }), "next-unit"],
		[key("K", { shiftKey: true }), "previous-unit"],
		[key("ArrowLeft", { shiftKey: true }), "previous-unit"],
		[key(" "), "reveal"],
		[key("Escape"), "clear"],
	] as [KeyLike, KeyAction][])("maps %o to %s", (event, action) => {
		expect(keyAction(event, full)).toBe(action);
	});

	it("leaves Space and Esc alone when they do not apply", () => {
		expect(keyAction(key(" "), plain)).toBeNull();
		expect(keyAction(key("Escape"), plain)).toBeNull();
		expect(keyAction(key(" ", { shiftKey: true }), full)).toBeNull();
	});

	it("ignores modified and composing keys", () => {
		for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
			expect(keyAction(key("j", mods), full)).toBeNull();
			expect(keyAction(key("ArrowRight", mods), full)).toBeNull();
		}
	});

	it("ignores other keys", () => {
		for (const k of ["l", "h", "ArrowUp", "ArrowDown", "PageDown", "Enter", "ñ"]) expect(keyAction(key(k), full)).toBeNull();
	});
});

describe("registerReadingKeys", () => {
	function setup(context: KeyContext | null = { revealable: false, hasCursor: true }) {
		const env = fakeEnv();
		owners.push(env.owner);
		const act = vi.fn<(action: KeyAction, repeat: boolean) => boolean>(() => true);
		registerReadingKeys(env.ctx, { context: () => context, act });
		const press = (k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
			const bubbled = vi.fn();
			document.body.addEventListener("keydown", bubbled);
			target.dispatchEvent(event);
			document.body.removeEventListener("keydown", bubbled);
			return { event, bubbled };
		};
		return { env, act, press };
	}

	it("handles reading keys in the capture phase and stops them", () => {
		const { act, press } = setup();
		const { event, bubbled } = press("j");
		expect(act).toHaveBeenCalledWith("next", false);
		expect(event.defaultPrevented).toBe(true);
		expect(bubbled).not.toHaveBeenCalled();
	});

	it("passes key repeat through", () => {
		const { act, press } = setup();
		press("ArrowRight", document.body, { repeat: true });
		expect(act).toHaveBeenCalledWith("next", true);
	});

	it("lets unhandled and inapplicable keys through", () => {
		const { act, press } = setup({ revealable: false, hasCursor: false });
		expect(press(" ").event.defaultPrevented).toBe(false);
		expect(press("Escape").event.defaultPrevented).toBe(false);
		expect(press("x").bubbled).toHaveBeenCalled();
		expect(act).not.toHaveBeenCalled();
	});

	it("does not prevent default when the action did not apply", () => {
		const { act, press } = setup();
		act.mockReturnValue(false);
		expect(press("k").event.defaultPrevented).toBe(false);
	});

	it("stays out of inputs, contenteditable and open modals", () => {
		const { act, press } = setup();
		const input = h("input");
		const editable = h("div", { contenteditable: "true" }, "Nota del lector");
		document.body.append(input, editable);
		press("j", input);
		press("j", editable);
		const modal = h("div", { class: "modal-container" });
		document.body.append(modal);
		press("j");
		modal.remove();
		input.remove();
		editable.remove();
		expect(act).not.toHaveBeenCalled();
	});

	it("does nothing without an active session leaf in reading view", () => {
		const { act, press } = setup(null);
		expect(press("j").event.defaultPrevented).toBe(false);
		expect(act).not.toHaveBeenCalled();
	});

	it("does nothing when reading keys are off", () => {
		const { env, act, press } = setup();
		env.settings.readingKeys = false;
		press("j");
		expect(act).not.toHaveBeenCalled();
	});

	it("registers on popout windows and unregisters on unload", () => {
		const { env, act } = setup();
		const popout = document.implementation.createHTMLDocument("popout");
		env.workspace.trigger("window-open", {}, { document: popout });
		popout.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(act).toHaveBeenCalledWith("previous", false);
		env.owner.unload();
		act.mockClear();
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		popout.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(act).not.toHaveBeenCalled();
	});

	it("removes a popout's listener when the popout closes", () => {
		const { env, act } = setup();
		const popout = document.implementation.createHTMLDocument("popout");
		const removed = vi.spyOn(popout, "removeEventListener");
		env.workspace.trigger("window-open", {}, { document: popout });
		env.workspace.trigger("window-close", {}, { document: popout });
		expect(removed).toHaveBeenCalledWith("keydown", expect.any(Function), { capture: true });
		popout.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(act).not.toHaveBeenCalled();
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(act).toHaveBeenCalledWith("previous", false);
	});
});
