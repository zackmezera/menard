// @vitest-environment happy-dom
import "./dom-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "obsidian";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import { DISCLOSURE, confirmAlign, confirmBatch, confirmReplaceEdited, confirmSplit, confirmTranslate, showReport } from "../../src/jobs/modals";

const app = {} as App;
let opened: Modal[] = [];

beforeEach(() => {
	opened = [];
	vi.spyOn(Modal.prototype, "open").mockImplementation(function (this: Modal) {
		opened.push(this);
		void this.onOpen();
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

function current(): HTMLElement {
	const modal = opened.at(-1);
	if (modal === undefined) throw new Error("no modal opened");
	return modal.contentEl;
}

function click(text: string): void {
	const button = [...current().querySelectorAll("button")].find((b) => b.textContent === text);
	if (button === undefined) throw new Error(`no button ${text}`);
	button.dispatchEvent(new Event("click"));
}

const PREFLIGHT = {
	sourceName: "@ruizalmotasim",
	languages: { source: "es", target: "en" },
	model: "sonnet",
	units: 74,
	idsToAdd: 74,
	skippedSections: ["Bibliografía"],
	firstUnit: "Ninguno de los problemas…",
	estimatedMinutes: 12.3,
	resume: false,
};

describe("job modals", () => {
	it("shows the disclosure before translating and returns the edited languages", async () => {
		const answer = confirmTranslate(app, PREFLIGHT);
		const text = current().textContent ?? "";
		expect(text).toContain("Translate 74 units of “@ruizalmotasim”.");
		expect(text).toContain(DISCLOSURE);
		expect(opened.at(-1)?.modalEl.classList.contains("menard-preflight")).toBe(true);
		expect(text).toContain("Skipped sections: Bibliografía");
		expect(text).toContain("Text starts with: “Ninguno de los problemas…”");
		expect(text).toContain("Estimated time: about 12 min");
		const [, target] = [...current().querySelectorAll("input")];
		if (target === undefined) throw new Error("no input");
		target.value = "fr";
		click("Translate");
		await expect(answer).resolves.toEqual({ source: "es", target: "fr" });
	});

	it("warns when the text looks like the target language and swaps on request (#25)", async () => {
		const answer = confirmTranslate(app, { ...PREFLIGHT, guessedSource: "en" });
		expect(current().textContent).toContain("The text looks like English, not Spanish.");
		click("Swap languages");
		const [source, target] = [...current().querySelectorAll("input")];
		expect([source?.value, target?.value]).toEqual(["en", "es"]);
		expect(current().textContent).not.toContain("looks like");
		click("Translate");
		await expect(answer).resolves.toEqual({ source: "en", target: "es" });
	});

	it("offers the guessed language as the source when it is not the target", async () => {
		const answer = confirmTranslate(app, { ...PREFLIGHT, guessedSource: "fr" });
		expect(current().textContent).toContain("The text looks like French, not Spanish.");
		click("Use French as the source");
		click("Translate");
		await expect(answer).resolves.toEqual({ source: "fr", target: "en" });
	});

	it("does not warn when the guess matches, and shows no swap on resume", () => {
		void confirmTranslate(app, { ...PREFLIGHT, guessedSource: "es" });
		expect(current().textContent).not.toContain("looks like");
		void confirmTranslate(app, { ...PREFLIGHT, guessedSource: "en", resume: true });
		expect([...current().querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Resume", "Cancel"]);
	});

	it("refuses the same language on both sides", async () => {
		const answer = confirmTranslate(app, PREFLIGHT);
		const [source, target] = [...current().querySelectorAll("input")];
		if (source === undefined || target === undefined) throw new Error("no inputs");
		target.value = "es-AR";
		target.dispatchEvent(new Event("input"));
		expect(current().textContent).toContain("The source and target languages are both Spanish.");
		click("Translate");
		expect(source.getAttribute("aria-invalid")).toBe("true");
		expect(target.getAttribute("aria-invalid")).toBe("true");
		opened.at(-1)?.close();
		await expect(answer).resolves.toBeNull();
	});

	it("asks for the split's languages, checks both halves and names the new note", async () => {
		const split = confirmSplit(app, {
			plan: { sourceText: "", translationBody: "", renamedFootnotes: {}, movedBlocks: 3, movedFootnotes: 0, copiedFootnotes: 0 },
			languages: { source: "es", target: "en" },
			translationPath: (target) => `T/@borgesversiones1932 (${target.toUpperCase()}).md`,
			guessedSource: "en",
			guessedTarget: "es",
		});
		expect(current().textContent).toContain("The text looks like English, not Spanish.");
		expect(current().textContent).toContain("New note: “@borgesversiones1932 (EN)”");
		click("Swap languages");
		expect(current().textContent).toContain("New note: “@borgesversiones1932 (ES)”");
		click("Split");
		await expect(split).resolves.toEqual({ source: "en", target: "es" });
	});

	it("warns when only the split's translation half looks wrong", () => {
		void confirmSplit(app, {
			plan: { sourceText: "", translationBody: "", renamedFootnotes: {}, movedBlocks: 3, movedFootnotes: 0, copiedFootnotes: 0 },
			languages: { source: "es", target: "en" },
			translationPath: (target) => `@x (${target}).md`,
			guessedSource: "es",
			guessedTarget: "fr",
		});
		expect(current().textContent).toContain("The translation looks like French, not English.");
		click("Use French as the target");
		expect([...current().querySelectorAll("input")].map((i) => i.value)).toEqual(["es", "fr"]);
	});

	it("resolves null when the preflight is dismissed", async () => {
		const answer = confirmTranslate(app, { ...PREFLIGHT, resume: true, units: 4 });
		expect(current().textContent).toContain("4 units of “@ruizalmotasim” still to translate.");
		opened.at(-1)?.close();
		await expect(answer).resolves.toBeNull();
	});

	it("previews an alignment, a split and an edited replacement", async () => {
		const align = confirmAlign(app, { sections: 6, paired: 68, sourceOnly: 4, targetOnly: 2, doubtful: ["Borges escribe… / Borges writes…"], merged: [] });
		expect(current().textContent).toContain("6 sections: 68 paired, 4 only in the source, 2 only in the translation.");
		expect(current().textContent).toContain("Borges escribe… / Borges writes…");
		click("Align");
		await expect(align).resolves.toBe(true);

		// Each list's label is a paragraph above its own list, not a bullet among the items .
		void confirmAlign(app, { sections: 1, paired: 2, sourceOnly: 0, targetOnly: 0, doubtful: ["A… / B…"], merged: ["Uno… + Dos… / One…"] });
		const labels = [...current().querySelectorAll("p")].map((p) => p.textContent);
		expect(labels).toEqual(expect.arrayContaining(["Read as one paragraph:", "Check these pairs:"]));
		const lists = [...current().querySelectorAll("ul")].map((ul) => [ul.previousElementSibling?.textContent, [...ul.children].map((li) => li.textContent)]);
		expect(lists).toEqual([
			["Read as one paragraph:", ["Uno… + Dos… / One…"]],
			["Check these pairs:", ["A… / B…"]],
		]);

		const split = confirmSplit(app, {
			plan: { sourceText: "", translationBody: "", renamedFootnotes: { "en-1": "1" }, movedBlocks: 23, movedFootnotes: 19, copiedFootnotes: 2 },
			languages: { source: "es", target: "en" },
			translationPath: (target) => `Collections/Texts/@ruizalmotasim (${target.toUpperCase()}).md`,
		});
		expect(current().textContent).toContain("Move 23 blocks and 19 footnotes into the new translation note.");
		expect(current().textContent).toContain("Copy 2 footnotes both texts cite; they stay in the source too.");
		expect(current().textContent).toContain("Rename footnotes [^en-1] to [^1].");
		expect(current().textContent).toContain("New note: “@ruizalmotasim (EN)”");
		click("Cancel");
		await expect(split).resolves.toBeNull();

		const replace = confirmReplaceEdited(app, "That reading, he says…");
		expect(current().textContent).toContain("This paragraph was edited after translation. Replace it? A backup is saved.");
		click("Replace");
		await expect(replace).resolves.toBe(true);
	});

	it("previews a folder batch with one language pair and a line per note", async () => {
		const file = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);
		const answer = confirmBatch(app, {
			folderName: "Texts",
			languages: { source: "es", target: "en" },
			model: "sonnet",
			items: [
				{ file: file("Texts/A.md"), action: "translate", target: null, calls: 4 },
				{ file: file("Texts/B.md"), action: "align", target: file("Texts/B (EN).md"), calls: 3 },
				{ file: file("Texts/C.md"), action: "done", target: file("Texts/C (EN).md"), calls: 0 },
			],
		});
		expect(current().textContent).toContain("2 notes in “Texts”, one after another in name order: about 7 Claude calls with sonnet.");
		expect([...current().querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			"A: translate, about 4 calls",
			"B: align with “B (EN)”, about 3 calls",
			"C: already done, skipped",
		]);
		const [, target] = [...current().querySelectorAll("input")];
		if (target) target.value = "fr";
		click("Start");
		await expect(answer).resolves.toEqual({ source: "es", target: "fr" });
	});

	it("shows only the report actions that apply", () => {
		const refresh = vi.fn();
		showReport(
			app,
			{ unpairedSource: [], untranslated: [], unpairedTarget: ["t1"], pending: [], repaired: ["p3"], degraded: [], problems: [11] },
			{ refresh, realign: vi.fn(), resume: vi.fn() },
		);
		const buttons = [...current().querySelectorAll("button")].map((b) => b.textContent);
		expect(buttons).toEqual(["Refresh maps", "Close"]);
		expect(current().textContent).toContain("Unreadable Menard lines (line numbers): 12");
		click("Refresh maps");
		expect(refresh).toHaveBeenCalledOnce();
	});
});
