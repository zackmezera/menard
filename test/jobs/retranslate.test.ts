import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { runRealign, runRetranslate, unitReplacements, wasEdited } from "../../src/jobs/retranslate";
import { runTranslate } from "../../src/jobs/translate";
import { parseNote } from "../../src/text/blocks";
import { callKind, createHarness, fakeClaude, payloadOf } from "./harness";
import type { Harness } from "./harness";
import { SOURCE_NOTE } from "./fixtures";

const SOURCE_PATH = "Collections/Texts/@perezlaberinto2019.md";
const TARGET_PATH = "Collections/Texts/@perezlaberinto2019 (EN).md";

async function translated(): Promise<Harness & { pair: { source: TFile; target: TFile } }> {
	const h = createHarness({ skipHeadings: "Bibliografía" });
	const source = h.vault.add(SOURCE_PATH, SOURCE_NOTE);
	await runTranslate(h.deps, source, new AbortController());
	const target = h.vault.getFileByPath(TARGET_PATH);
	if (target === null) throw new Error("no translation");
	return { ...h, pair: { source, target } };
}

describe("runRetranslate", () => {
	it("asks before replacing an edited translation, then backs up and replaces block and map in one write", async () => {
		const h = await translated();
		const original = h.vault.text(TARGET_PATH);
		const edited = original.replace("EN Esa lectura, dice, fue decisiva", "That reading, he says, was decisive");
		h.vault.edit(h.pair.target, edited);

		h.ui.answers.replaceEdited = false;
		await runRetranslate(h.deps, h.pair, "p1", new AbortController());
		expect(h.ui.replacePreviews[0]).toContain("That reading, he says, was decisive");
		expect(h.vault.text(TARGET_PATH)).toBe(edited);
		expect(h.vault.adapterFiles.size).toBe(0);

		h.ui.answers.replaceEdited = true;
		await runRetranslate(h.deps, h.pair, "p1", new AbortController());
		expect(h.vault.text(TARGET_PATH)).toBe(original);
		const backups = [...h.vault.adapterFiles.entries()];
		expect(backups).toHaveLength(1);
		expect(backups[0]?.[0]).toMatch(/^\.obsidian-test\/plugins\/menard\/backups\/\d{8}-\d{6}-@perezlaberinto2019 \(EN\)\.md$/);
		expect(backups[0]?.[1]).toBe(edited);
		expect(h.ui.summaries.at(-1)?.text).toBe("Re-translated p1. A backup of the previous translation was saved.");
	});

	it("does not ask about an unedited translation, and says so when Claude returns the same text", async () => {
		const h = await translated();
		const before = h.vault.text(TARGET_PATH);
		await runRetranslate(h.deps, h.pair, "p3", new AbortController());
		expect(h.ui.replacePreviews).toEqual([]);
		expect(h.vault.text(TARGET_PATH)).toBe(before);
		expect(h.vault.adapterFiles.size).toBe(0);
		expect(h.ui.summaries.at(-1)?.text).toBe("Claude returned the same translation for p3; nothing changed.");
	});

	it("keeps the translation when the model keeps failing", async () => {
		const h = await translated();
		const before = h.vault.text(TARGET_PATH);
		h.backend.handler = () => ({ groups: [] });
		await runRetranslate(h.deps, h.pair, "p3", new AbortController());
		expect(h.vault.text(TARGET_PATH)).toBe(before);
		expect(h.ui.summaries.at(-1)?.text).toMatch(/^Claude's answer was rejected/);
	});
});

describe("runRealign", () => {
	it("swaps the map for an align marker and writes a new map", async () => {
		const h = await translated();
		h.backend.handler = (request) => {
			if (callKind(request) !== "align") return fakeClaude(request);
			const { source, target } = payloadOf<{ source: unknown[]; target: unknown[] }>(request);
			const all = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
			return { groups: [{ src: all(source.length), tgt: all(target.length), loose: true }] };
		};
		await runRealign(h.deps, h.pair, "p1", new AbortController());
		expect(h.vault.text(TARGET_PATH)).toMatch(/\^p1\n\n%%menard:1 p1 29\.\w{4}\/31\.\w{4}\?%%\n/);
	});

	it("refuses units without a sentence map", async () => {
		const h = await translated();
		await runRealign(h.deps, h.pair, "p4", new AbortController());
		expect(h.ui.notices).toEqual(["Only paragraphs, quotes and callouts have sentence maps to realign."]);
	});
});

describe("wasEdited and unitReplacements", () => {
	const options = { textStartHeading: "", skipHeadings: [] };

	it("treats every unit without a map as edited, lists included", () => {
		const [paragraph, list] = parseNote("Una frase. ^p1\n\n- uno\n\n^p2\n", options).blocks;
		expect(wasEdited(paragraph as never, null)).toBe(true);
		expect(wasEdited(list as never, null)).toBe(true);
	});

	it("replaces block and map together, and removes a map that wandered away", () => {
		const together = "A. ^p1\n\n%%menard:1 p1 1.aaaa/1.bbbb%%\n";
		expect(unitReplacements(together, "p1", "B. ^p1\n\n%%menard:1 p1 1.cccc/1.dddd%%", options)).toEqual([
			{ from: 0, to: 37, expect: "A. ^p1\n\n%%menard:1 p1 1.aaaa/1.bbbb%%", text: "B. ^p1\n\n%%menard:1 p1 1.cccc/1.dddd%%" },
		]);
		const apart = "A. ^p1\n\nOther text.\n\n%%menard:1 p1 1.aaaa/1.bbbb%%\n";
		const replacements = unitReplacements(apart, "p1", "B. ^p1", options);
		expect(replacements).toEqual([
			{ from: 0, to: 6, expect: "A. ^p1", text: "B. ^p1" },
			{ from: 19, to: 50, expect: "\n\n%%menard:1 p1 1.aaaa/1.bbbb%%", text: "" },
		]);
		expect(unitReplacements("Nothing here.\n", "p1", "B.", options)).toBe("conflict");
	});
});
