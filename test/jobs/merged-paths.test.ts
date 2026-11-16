/**
 * Merged units (ADR 0010) beyond reading: Re-translate, Re-align and Check
 * alignment on a 2-1 and a 1-2 unit, end to end through the jobs.
 */
import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { fitUnitSide } from "../../src/align/merge";
import { buildPairModel, unitBlocks } from "../../src/align/model";
import { wordsOf } from "../../src/align/words";
import { runAlign } from "../../src/jobs/align";
import { reportPair, runCheck } from "../../src/jobs/check";
import { runRealign, runRetranslate } from "../../src/jobs/retranslate";
import { parseNote, textUnits } from "../../src/text/blocks";
import { projectMarkdown } from "../../src/text/inline";
import type { PairModel } from "../../src/types";
import { callKind, createHarness, fakeClaude } from "./harness";
import type { Harness } from "./harness";

const SOURCE_PATH = "Collections/Texts/@molloyletras1979.md";
const TARGET_PATH = "Collections/Texts/@molloyletras1979 (EN).md";
const OPTIONS = { textStartHeading: "", skipHeadings: [] };

const SOURCE = [
	"Costumbre de Borges, de una lectura previsible.",
	"Detenerse en lo que se incorpora. ¿Qué otra cosa es leer?",
	"La superstición del texto fluido inaugura malas costumbres.",
	"Acudo a una primera persona del plural. Es discutible.",
	"Fin del prólogo.",
	"Gracias.",
	"",
].join("\n\n");
/** English p2 renders Spanish p2 and p3 (2-1); English p3 and p4 render Spanish p4 (1-2); English p5, Spanish p5 and p6. */
const TARGET = [
	"To read Borges has become a habit.",
	"To undo the habit, to dwell on the text: isn't that what reading is about? The promise of a flowing text gives rise to bad habits.",
	"I use the first person plural.",
	"That use is questionable.",
	"End of the preface. Thanks.",
	"",
].join("\n\n");
const PAIRING = { groups: [{ src: [1], tgt: [1] }, { src: [2, 3], tgt: [2] }, { src: [4], tgt: [3, 4] }, { src: [5, 6], tgt: [5] }] };

type Aligned = Harness & { source: TFile; target: TFile };

async function aligned(): Promise<Aligned> {
	const h = createHarness();
	h.backend.handler = (request) => (callKind(request) === "pairing" ? PAIRING : fakeClaude(request));
	const source = h.vault.add(SOURCE_PATH, SOURCE);
	const target = h.vault.add(TARGET_PATH, TARGET);
	await runAlign(h.deps, source, target, new AbortController());
	return { ...h, source, target };
}

function modelOf(h: Aligned): PairModel {
	return buildPairModel({
		sourcePath: SOURCE_PATH,
		targetPath: TARGET_PATH,
		languages: { source: "es", target: "en" },
		version: 1,
		source: parseNote(h.vault.text(h.source), OPTIONS),
		target: parseNote(h.vault.text(h.target), OPTIONS),
	});
}

function unitWords(text: string): string[][] {
	return textUnits(parseNote(text, OPTIONS)).map((block) => wordsOf(projectMarkdown(block.body).text).map((word) => word.norm));
}

const CLEAN = { unpairedSource: [], untranslated: [], unpairedTarget: [], pending: [], repaired: [], degraded: [], problems: [] };

/** Every unit's key group, and whether each side reads exactly against its map. */
function shape(model: PairModel): string[] {
	return model.units.map((unit) => {
		const keys = unit.group?.keys ?? [unit.key];
		const blocks = `${unitBlocks(unit, "source").length}-${unitBlocks(unit, "target").length}`;
		const fit = unit.map === null ? "none" : `${fitUnitSide(unit, "source")?.status}`;
		return `${keys.join("+")} ${blocks} ${fit === `${fitUnitSide(unit, "target")?.status}` ? fit : "mixed"}`;
	});
}

describe("merged units beyond reading (ADR 0010)", () => {
	it("aligns a 2-1 and a 1-2 unit, and Check alignment reports none of their paragraphs as untranslated or unpaired", async () => {
		const h = await aligned();
		expect(h.vault.text(h.target)).toMatch(/%%menard:1 p2\+p3 /);
		expect(h.vault.text(h.target)).toMatch(/%%menard:1 p4\+p7 /);
		const model = modelOf(h);
		expect(model.problems).toEqual([]);
		expect(shape(model)).toEqual(["p1 1-1 exact", "p2+p3 2-1 exact", "p4+p7 1-2 exact", "p5+p6 2-1 exact"]);
		expect(reportPair(model, parseNote(h.vault.text(h.source), OPTIONS))).toEqual(CLEAN);

		await runCheck(h.deps, h.source, (work) => work(new AbortController()));
		expect(h.ui.reports.at(-1)?.report).toEqual(CLEAN);
	});

	it("refreshes a merged map after an edit in its second source paragraph, keeping the group", async () => {
		const h = await aligned();
		h.vault.edit(h.source, h.vault.text(h.source).replace("malas costumbres", "pésimas costumbres"));
		await runCheck(h.deps, h.source, (work) => work(new AbortController()));
		const { report, actions } = h.ui.reports.at(-1) ?? {};
		expect(report).toMatchObject({ untranslated: [], unpairedSource: [], repaired: ["p2"], degraded: [] });
		actions?.refresh?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.ui.notices.at(-1)).toBe("Refreshed 1 sentence map.");
		expect(h.vault.text(h.target)).toMatch(/%%menard:1 p2\+p3 /);
		expect(shape(modelOf(h))).toContain("p2+p3 2-1 exact");
	});

	it("re-aligns a 1-2 unit as one, keeping its key group", async () => {
		const h = await aligned();
		await runRealign(h.deps, { source: h.source, target: h.target }, "p4", new AbortController());
		expect(h.vault.text(h.target)).toMatch(/%%menard:1 p4\+p7 /);
		expect(shape(modelOf(h))).toContain("p4+p7 1-2 exact");
	});

	it("re-translates a 2-1 unit paragraph by paragraph: a backup, two units that read exactly, a clean report", async () => {
		const h = await aligned();
		const before = h.vault.text(h.target);
		await runRetranslate(h.deps, { source: h.source, target: h.target }, "p3", new AbortController());
		expect(h.ui.summaries.at(-1)?.text).toBe("Re-translated p2. A backup of the previous translation was saved.");
		expect([...h.vault.adapterFiles.values()]).toContain(before);

		const text = h.vault.text(h.target);
		expect(text).not.toContain("p2+p3");
		expect(text).not.toContain("bad habits");
		expect(text).toMatch(/EN Detenerse en lo que se incorpora\. EN ¿Qué otra cosa es leer\? \^p2\n\n%%menard:1 p2 \S+ \S+%%\n\nEN La superstición del texto fluido inaugura malas costumbres\. \^p3\n\n%%menard:1 p3 \S+%%\n\nI use/);
		expect(unitWords(h.vault.text(h.source))).toEqual(unitWords(SOURCE));
		const model = modelOf(h);
		expect(model.problems).toEqual([]);
		expect(shape(model)).toEqual(["p1 1-1 exact", "p2 1-1 exact", "p3 1-1 exact", "p4+p7 1-2 exact", "p5+p6 2-1 exact"]);
		expect(reportPair(model, parseNote(h.vault.text(h.source), OPTIONS))).toEqual(CLEAN);
	});

	it("re-translates a 1-2 unit into one paragraph, dropping the translation-only id", async () => {
		const h = await aligned();
		const before = h.vault.text(h.target);
		await runRetranslate(h.deps, { source: h.source, target: h.target }, "p4", new AbortController());
		expect([...h.vault.adapterFiles.values()]).toContain(before);
		const text = h.vault.text(h.target);
		expect(text).not.toContain("p4+p7");
		expect(text).not.toMatch(/\^p7/);
		expect(text).toMatch(/EN Acudo a una primera persona del plural\. EN Es discutible\. \^p4\n\n%%menard:1 p4 \S+ \S+%%\n\nEnd of the preface/);
		const model = modelOf(h);
		expect(model.problems).toEqual([]);
		expect(shape(model)).toEqual(["p1 1-1 exact", "p2+p3 2-1 exact", "p4 1-1 exact", "p5+p6 2-1 exact"]);
		expect(reportPair(model, parseNote(h.vault.text(h.source), OPTIONS))).toEqual(CLEAN);
	});

	it("asks before re-translating a merged unit whose second paragraph was edited, and keeps it on no", async () => {
		const h = await aligned();
		const edited = h.vault.text(h.target).replace("That use is questionable.", "That use is, I admit, questionable.");
		h.vault.edit(h.target, edited);
		h.ui.answers.replaceEdited = false;
		await runRetranslate(h.deps, { source: h.source, target: h.target }, "p4", new AbortController());
		expect(h.ui.replacePreviews).toHaveLength(1);
		expect(h.ui.replacePreviews[0]).toContain("I admit");
		expect(h.vault.text(h.target)).toBe(edited);
	});
});
