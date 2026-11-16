import { describe, expect, it } from "vitest";
import { TFolder } from "obsidian";
import { planBatch, runBatch } from "../../src/jobs/batch";
import { batchLines } from "../../src/jobs/modals";
import { pendingMarkers, runTranslate } from "../../src/jobs/translate";
import { callKind, createHarness } from "./harness";
import type { Harness } from "./harness";

const DIR = "Collections/Texts";

/** A folder whose children are the notes the vault holds in it now, as Obsidian keeps them. */
function folderOf(h: Harness): TFolder {
	const folder = new (TFolder as unknown as new (path: string) => TFolder)(DIR);
	Object.defineProperty(folder, "children", { get: () => h.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${DIR}/`)) });
	return folder;
}

function setup(): Harness {
	const h = createHarness();
	h.vault.add(`${DIR}/B.md`, "Borges escribe. Lee mucho.\n\nSegundo párrafo.\n");
	h.vault.add(`${DIR}/B (EN).md`, "Borges writes. He reads a lot.\n\nSecond paragraph.\n");
	h.vault.add(`${DIR}/A.md`, "Uno. Dos.\n\nTres.\n");
	h.vault.add(`${DIR}/D.md`, "# Only a heading\n");
	h.vault.add(`${DIR}/C.md`, "Ya traducido.\n");
	return h;
}

describe("folder batch", () => {
	it("plans in name order, leaving out translations and notes without text, and skips a finished pair", async () => {
		const h = setup();
		await runTranslate(h.deps, h.vault.getFileByPath(`${DIR}/C.md`)!, new AbortController());
		const items = await planBatch(h.deps, folderOf(h), "en");
		expect(items.map((item) => [item.file.basename, item.action, item.target?.basename ?? null, item.calls])).toEqual([
			["A", "translate", null, 2],
			["B", "align", "B (EN)", 2],
			["C", "done", "C (EN)", 0],
		]);
		expect(batchLines(items)).toEqual([
			"A: translate, about 2 calls",
			"B: align with “B (EN)”, about 2 calls",
			"C: already done, skipped",
		]);
	});

	it("translates and aligns every note with one preflight and one progress, then summarizes per note", async () => {
		const h = setup();
		await runBatch(h.deps, folderOf(h), new AbortController());
		expect(h.ui.batchPreflights).toHaveLength(1);
		expect(h.ui.preflights).toHaveLength(0);
		expect(h.ui.alignSummaries).toHaveLength(0);
		expect(h.vault.text(`${DIR}/A (EN).md`)).toContain("EN Uno. Dos. ^p1");
		expect(pendingMarkers(h.vault.text(`${DIR}/A (EN).md`), "translate")).toEqual([]);
		expect(h.vault.text(`${DIR}/B (EN).md`)).toMatch(/He reads a lot\. \^p1\n\n%%menard:1 p1 /);
		expect(h.vault.text(`${DIR}/B (EN).md`)).toContain("sourceLanguage: es\ntargetLanguage: en");
		expect(h.ui.summaries).toHaveLength(1);
		expect(h.ui.summaries[0]?.text).toBe("3 notes processed in Texts. See the summary.");
		expect(h.ui.explained.at(-1)?.message.split("\n")).toEqual(["A: Translated 2 of 2.", "B: Aligned 2 of 2.", "C: Translated 1 of 1."]);
		const totals = h.ui.progressUpdates.map((update) => update[3]);
		expect(new Set(totals).size).toBe(1);

		// Everything is done now.
		await runBatch(h.deps, folderOf(h), new AbortController());
		expect(h.ui.notices.at(-1)).toBe("Every note in this folder is already translated or aligned.");
	});

	it("stops after the current note's units on cancel, and resumes on the next run", async () => {
		const h = setup();
		const controller = new AbortController();
		h.ui.onProgress = (done) => {
			if (done >= 1) controller.abort();
		};
		await runBatch(h.deps, folderOf(h), controller);
		const lines = h.ui.explained.at(-1)?.message.split("\n") ?? [];
		expect(lines[0]).toMatch(/^A: Translation cancelled: 1 of 2 written/);
		expect(lines.slice(1)).toEqual(["B: not started.", "C: not started."]);
		expect(h.ui.summaries.at(-1)?.text).toMatch(/^Stopped\. Run the command again to resume\./);

		h.ui.onProgress = null;
		const items = await planBatch(h.deps, folderOf(h), "en");
		expect(items.map((item) => [item.file.basename, item.action, item.calls])).toEqual([
			["A", "resume", 1],
			["B", "align", 2],
			["C", "translate", 1],
		]);
		const before = h.backend.requests.length;
		await runBatch(h.deps, folderOf(h), new AbortController());
		expect(h.backend.requests.slice(before).filter((request) => callKind(request) === "translate")).toHaveLength(2);
		expect(pendingMarkers(h.vault.text(`${DIR}/A (EN).md`), "translate")).toEqual([]);
	});

	it("does nothing when the preflight is cancelled", async () => {
		const h = setup();
		h.ui.answers.batch = false;
		await runBatch(h.deps, folderOf(h), new AbortController());
		expect(h.vault.getFileByPath(`${DIR}/A (EN).md`)).toBeNull();
		expect(h.backend.requests).toHaveLength(0);
	});
});
