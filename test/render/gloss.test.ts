// @vitest-environment happy-dom
import { section } from "./dom-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, MarkdownRenderer } from "obsidian";
import { sideSig } from "../../src/align/signature";
import { wordsOf } from "../../src/align/words";
import { ATTR, CLS } from "../../src/constants";
import { OffscreenGloss } from "../../src/render/gloss";
import type { MapLink, PairModel } from "../../src/types";
import { block, fakeApp, fakeModel, linksOf, SOURCE_PATH, TARGET_PATH } from "./fakes";
import { QUIJOTE_MAP, QUIJOTE_SOURCE_NOTE, QUIJOTE_TARGET_HTML, QUIJOTE_TARGET_NOTE, QUIJOTE_TARGET_S1 } from "./fixtures";

const QUIJOTE_TARGET_MARKDOWN = (QUIJOTE_TARGET_NOTE.split("\n")[6] ?? "").replace(/ \^p1$/, "");

const LACAN_MARKDOWN = "He cites [[Lacan, Jacques|Lacan]] on *desire and its interpretation* at length. Then he stops.";
const LACAN_HTML =
	'<p>He cites <a data-href="Lacan, Jacques" href="Lacan, Jacques" class="internal-link">Lacan</a> on <em>desire and its interpretation</em> at length. Then he stops.</p>';
const TARGET_NOTE = `${QUIJOTE_TARGET_NOTE}\n${LACAN_MARKDOWN} ^p2\n\n- uno\n- dos\n\n^p3\n`;
const LACAN_LINE = QUIJOTE_TARGET_NOTE.split("\n").length;

/** Reading-view markup for each Markdown body the gloss renders. */
const RENDERED: Record<string, string> = {
	[QUIJOTE_TARGET_MARKDOWN]: QUIJOTE_TARGET_HTML,
	[LACAN_MARKDOWN]: LACAN_HTML,
	"- uno\n- dos": "<ul><li>uno</li><li>dos</li></ul>",
};

function lacanLinks(): MapLink[] {
	const words = wordsOf("He cites Lacan on desire and its interpretation at length. Then he stops.");
	const first = { start: 0, end: 10 };
	const second = { start: 10, end: 13 };
	return [
		{ src: sideSig(words, first), tgt: sideSig(words, first), loose: false },
		{ src: sideSig(words, second), tgt: sideSig(words, second), loose: false },
		// A source-only sentence: a flagged span with nothing to show in the gloss.
		{ src: { count: 4, hash: "0abc" }, tgt: null, loose: false },
	];
}

function model(version = 1): PairModel {
	return fakeModel(
		[
			{ key: "p1", source: block("paragraph", 4, 5, "p1"), target: block("paragraph", 6, 7, "p1"), links: linksOf(QUIJOTE_MAP), mapLine: 8 },
			{ key: "p2", source: block("paragraph", 9, 10, "p2"), target: block("paragraph", LACAN_LINE, LACAN_LINE + 1, "p2"), links: lacanLinks() },
			{ key: "p3", kind: "list", source: block("list", 11, 13), target: block("list", LACAN_LINE + 2, LACAN_LINE + 4) },
			{ key: "p4", source: block("paragraph", 14, 15, "p4"), target: null },
		],
		version,
	);
}

function setup() {
	const fake = fakeApp({ [SOURCE_PATH]: QUIJOTE_SOURCE_NOTE, [TARGET_PATH]: TARGET_NOTE });
	const cachedRead = vi.spyOn(fake.app.vault, "cachedRead");
	const containers: HTMLElement[] = [];
	const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
		containers.push(el);
		// The gloss appends stand-in definitions so refs render; the fixtures are keyed by the unit's own Markdown.
		const html = RENDERED[markdown.split(/\n\n\[\^/)[0] ?? markdown];
		if (html === undefined) throw new Error(`no fixture for ${JSON.stringify(markdown)}`);
		el.appendChild(section(html).firstElementChild as HTMLElement);
		return Promise.resolve();
	});
	const owner = new Component();
	const addChild = vi.spyOn(owner, "addChild");
	const removeChild = vi.spyOn(owner, "removeChild");
	return { ...fake, gloss: new OffscreenGloss(fake.app), cachedRead, render, containers, owner, addChild, removeChild };
}

afterEach(() => vi.restoreAllMocks());

describe("OffscreenGloss", () => {
	it("renders the target of a link stop offscreen and clones its fragments", async () => {
		const { gloss, owner, containers, addChild } = setup();
		const into = document.createElement("span");
		expect(await gloss.render(model(), { unit: "p1", link: 1 }, into, owner)).toBe(true);
		expect(into.textContent).toBe(`${QUIJOTE_TARGET_S1}[1]`);
		expect(into.querySelector("sup.footnote-ref")).not.toBeNull();
		expect(into.querySelector(`[${ATTR.link}]`)).toBeNull();
		expect(containers[0]?.hasAttribute(ATTR.offscreen)).toBe(true);
		expect(containers[0]?.isConnected).toBe(false);
		expect(addChild).toHaveBeenCalledTimes(1);
	});

	it("renders the Markdown of the target unit without its block id, with its footnotes defined", async () => {
		const { gloss, owner, render } = setup();
		await gloss.render(model(), { unit: "p1", link: 2 }, document.createElement("span"), owner);
		expect(render.mock.calls[0]?.[1]).toBe(`${QUIJOTE_TARGET_MARKDOWN}\n\n[^1]: 1`);
		expect(render.mock.calls[0]?.[3]).toBe(TARGET_PATH);
	});

	it("keeps the emphasis and links around a cloned link", async () => {
		const { gloss, owner } = setup();
		const into = document.createElement("span");
		await gloss.render(model(), { unit: "p2", link: 1 }, into, owner);
		expect(into.textContent).toBe("He cites Lacan on desire and its interpretation at length.");
		expect(into.querySelector("a.internal-link")?.textContent).toBe("Lacan");
		expect(into.querySelector("em")?.textContent).toBe("desire and its interpretation");
		expect(into.querySelectorAll(`span.${CLS.sentence}`).length).toBeGreaterThan(1);
	});

	it("clones the whole unit for a whole-unit stop", async () => {
		const { gloss, owner } = setup();
		const into = document.createElement("span");
		expect(await gloss.render(model(), { unit: "p3", link: null }, into, owner)).toBe(true);
		expect(into.querySelectorAll("li")).toHaveLength(2);
	});

	it("replaces what the gloss showed before", async () => {
		const { gloss, owner } = setup();
		const into = document.createElement("span");
		await gloss.render(model(), { unit: "p1", link: 1 }, into, owner);
		await gloss.render(model(), { unit: "p1", link: 2 }, into, owner);
		expect(into.textContent).toMatch(/^An olla .* income\.$/);
	});

	it("resolves false when there is nothing to show", async () => {
		const { gloss, owner } = setup();
		const into = document.createElement("span");
		expect(await gloss.render(model(), { unit: "p2", link: 3 }, into, owner)).toBe(false);
		expect(await gloss.render(model(), { unit: "p4", link: null }, into, owner)).toBe(false);
		expect(await gloss.render(model(), { unit: "nope", link: 1 }, into, owner)).toBe(false);
		expect(into.childNodes).toHaveLength(0);
	});

	it("opens internal links relative to the target note", async () => {
		const { gloss, owner, openLinkText } = setup();
		owner.load();
		const into = document.createElement("span");
		await gloss.render(model(), { unit: "p2", link: 1 }, into, owner);
		await gloss.render(model(), { unit: "p2", link: 1 }, into, owner);
		const anchor = into.querySelector("a.internal-link") as HTMLElement;
		anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(openLinkText).toHaveBeenCalledTimes(1);
		expect(openLinkText).toHaveBeenCalledWith("Lacan, Jacques", TARGET_PATH);
		into.querySelector("em")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(openLinkText).toHaveBeenCalledTimes(1);
	});

	it("reuses a rendered unit until the model version changes", async () => {
		const { gloss, owner, cachedRead, removeChild } = setup();
		const into = document.createElement("span");
		await gloss.render(model(1), { unit: "p1", link: 1 }, into, owner);
		await gloss.render(model(1), { unit: "p1", link: 2 }, into, owner);
		expect(cachedRead).toHaveBeenCalledTimes(1);
		await gloss.render(model(2), { unit: "p1", link: 1 }, into, owner);
		expect(cachedRead).toHaveBeenCalledTimes(2);
		await Promise.resolve();
		expect(removeChild).toHaveBeenCalledTimes(1);
	});

	it("keeps at most 32 rendered units, evicting the least recently used", async () => {
		const { gloss, owner, cachedRead, removeChild } = setup();
		const lists = fakeModel(
			Array.from({ length: 33 }, (_, i) => ({ key: `l${i}`, kind: "list" as const, source: null, target: block("list", LACAN_LINE + 2, LACAN_LINE + 4) })),
		);
		const into = document.createElement("span");
		for (let i = 0; i < 32; i++) await gloss.render(lists, { unit: `l${i}`, link: null }, into, owner);
		await gloss.render(lists, { unit: "l0", link: null }, into, owner);
		await gloss.render(lists, { unit: "l32", link: null }, into, owner);
		expect(cachedRead).toHaveBeenCalledTimes(33);
		await Promise.resolve();
		expect(removeChild).toHaveBeenCalledTimes(1);
		await gloss.render(lists, { unit: "l0", link: null }, into, owner);
		expect(cachedRead).toHaveBeenCalledTimes(33);
		await gloss.render(lists, { unit: "l1", link: null }, into, owner);
		expect(cachedRead).toHaveBeenCalledTimes(34);
	});

	it("lets the latest render win when an earlier one finishes after it", async () => {
		const { gloss, owner, cachedRead, files } = setup();
		const into = document.createElement("span");
		// Warm the cache for p2 so its render resolves before p1's first read.
		await gloss.render(model(), { unit: "p2", link: 1 }, into, owner);
		let release: () => void = () => {};
		cachedRead.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(files.get(TARGET_PATH) ?? ""))));
		const slow = gloss.render(model(), { unit: "p1", link: 1 }, into, owner);
		const fast = gloss.render(model(), { unit: "p2", link: 2 }, into, owner);
		expect(await fast).toBe(true);
		release();
		expect(await slow).toBe(false);
		expect(into.textContent).toBe("Then he stops.");
	});

	it("retries a unit whose render failed, without leaking its render child", async () => {
		const { gloss, owner, render, addChild, removeChild } = setup();
		const into = document.createElement("span");
		render.mockImplementationOnce(() => Promise.reject(new Error("render failed")));
		expect(await gloss.render(model(), { unit: "p3", link: null }, into, owner)).toBe(false);
		expect(removeChild).toHaveBeenCalledTimes(1);
		expect(removeChild.mock.calls[0]?.[0]).toBe(addChild.mock.results[0]?.value);
		expect(await gloss.render(model(), { unit: "p3", link: null }, into, owner)).toBe(true);
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("keeps a handled link click from reaching the reading view around the gloss", async () => {
		const { gloss, owner, openLinkText } = setup();
		owner.load();
		const view = document.createElement("div");
		const into = view.appendChild(document.createElement("span"));
		const outer = vi.fn();
		view.addEventListener("click", outer);
		await gloss.render(model(), { unit: "p2", link: 1 }, into, owner);
		into.querySelector("a.internal-link")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(openLinkText).toHaveBeenCalledTimes(1);
		expect(outer).not.toHaveBeenCalled();
		into.querySelector("em")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(outer).toHaveBeenCalledTimes(1);
	});
});

describe("OffscreenGloss footnote refs", () => {
	// Two footnotes are referenced before this paragraph, so reading view shows its ref as 3.
	const NOTE = [
		"First paragraph.[^1] ^p1",
		"",
		"Second paragraph.[^2] ^p2",
		"",
		"Borges read Poe in Geneva.[^3] That reading was decisive. ^p3",
		"",
		"[^1]: One.",
		"[^2]: Two.",
		"[^3]: See Molloy.",
		"",
	].join("\n");
	const words = wordsOf("Borges read Poe in Geneva. That reading was decisive.");
	const first = { start: 0, end: 5 };
	const second = { start: 5, end: 9 };
	const links: MapLink[] = [
		{ src: sideSig(words, first), tgt: sideSig(words, first), loose: false },
		{ src: sideSig(words, second), tgt: sideSig(words, second), loose: false },
	];

	/** Renders like reading view: a ref with a definition becomes a numbered sup, one without stays literal. */
	function renderLikeObsidian(markdown: string, el: HTMLElement): void {
		const defined = new Set(Array.from(markdown.matchAll(/^\[\^([^\]]+)\]:/gm), (m) => m[1]));
		const numbers = new Map<string, number>();
		const [body = ""] = markdown.split(/\n\n(?=\[\^[^\]]+\]:)/);
		const html = body.replace(/\[\^([^\]]+)\](?!:)/g, (raw, label: string) => {
			if (!defined.has(label)) return raw;
			const n = numbers.get(label) ?? numbers.size + 1;
			numbers.set(label, n);
			return `<sup data-footnote-id="fnref-${n}-ab12" class="footnote-ref"><a href="#fn-${n}-ab12" class="footnote-link">[${n}]</a></sup>`;
		});
		el.appendChild(section(`<p>${html}</p>`).firstElementChild as HTMLElement);
		if (defined.size > 0) el.appendChild(section(`<section class="footnotes"><ol><li>…</li></ol></section>`).firstElementChild as HTMLElement);
	}

	function setupNote() {
		const fake = fakeApp({ [TARGET_PATH]: NOTE });
		vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
			renderLikeObsidian(markdown, el);
			return Promise.resolve();
		});
		const m = fakeModel([{ key: "p3", source: block("paragraph", 4, 5, "p3"), target: block("paragraph", 4, 5, "p3"), links }]);
		return { gloss: new OffscreenGloss(fake.app), model: m, owner: new Component(), openLinkText: fake.openLinkText };
	}

	it("renders a footnote ref as a real ref numbered as in the translation note, not as '[^3]'", async () => {
		const { gloss, model: m, owner } = setupNote();
		const into = document.createElement("span");
		expect(await gloss.render(m, { unit: "p3", link: 1 }, into, owner)).toBe(true);
		expect(into.textContent).not.toContain("[^3]");
		const sup = into.querySelector("sup.footnote-ref");
		expect(sup?.textContent).toBe("[3]");
		expect(into.textContent).toBe("Borges read Poe in Geneva.[3]");
		expect(into.querySelector("section.footnotes")).toBeNull();
	});

	it("keeps a click on a footnote ref inside the gloss", async () => {
		const { gloss, model: m, owner, openLinkText } = setupNote();
		owner.load();
		const view = document.createElement("div");
		const into = view.appendChild(document.createElement("span"));
		const outer = vi.fn();
		view.addEventListener("click", outer);
		await gloss.render(m, { unit: "p3", link: 1 }, into, owner);
		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		into.querySelector("sup.footnote-ref a")?.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(outer).not.toHaveBeenCalled();
		expect(openLinkText).not.toHaveBeenCalled();
	});
});
