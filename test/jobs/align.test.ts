import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { buildPairModel } from "../../src/align/model";
import { wordsOf } from "../../src/align/words";
import { planAlign, runAlign } from "../../src/jobs/align";
import { reportPair } from "../../src/jobs/check";
import { runRealign, runRetranslate } from "../../src/jobs/retranslate";
import { pendingMarkers, runTranslate } from "../../src/jobs/translate";
import { parseNote, textUnits } from "../../src/text/blocks";
import { projectMarkdown } from "../../src/text/inline";
import { callKind, createHarness, fakeClaude, payloadOf } from "./harness";
import type { Harness } from "./harness";
import { ALIGN_SOURCE, ALIGN_TARGET } from "./fixtures";

const SOURCE_PATH = "Collections/Texts/@sarloborges1993.md";
const TARGET_PATH = "Collections/Texts/@sarloborges1993 (EN).md";
const OPTIONS = { textStartHeading: "", skipHeadings: [] };

/** The words of every unit, in order: what Align must never change. */
function unitWords(text: string): string[][] {
	return textUnits(parseNote(text, OPTIONS)).map((block) => wordsOf(projectMarkdown(block.body).text).map((word) => word.norm));
}

describe("runAlign", () => {
	it("aligns an existing translation without changing a word, flagging the translator's note", async () => {
		const h = createHarness();
		h.backend.handler = (request) => {
			if (callKind(request) !== "align") return fakeClaude(request);
			const { target } = payloadOf<{ target: { text: string }[] }>(request);
			if (target.some((sentence) => sentence.text.startsWith("[Translator's note"))) {
				return { groups: [{ src: [1], tgt: [1], loose: false }, { src: [2], tgt: [2], loose: false }, { src: [], tgt: [3], loose: false }] };
			}
			return fakeClaude(request);
		};
		const source = h.vault.add(SOURCE_PATH, ALIGN_SOURCE);
		const target = h.vault.add(TARGET_PATH, ALIGN_TARGET);
		await runAlign(h.deps, source, target, new AbortController());

		const sourceText = h.vault.text(source);
		const targetText = h.vault.text(target);
		expect(unitWords(sourceText)).toEqual(unitWords(ALIGN_SOURCE));
		expect(unitWords(targetText)).toEqual(unitWords(ALIGN_TARGET));

		expect(sourceText).toContain("biblioteca europea. ^p1\n");
		expect(sourceText).toContain("ya son mi entraña.»\n\n^p2\n");
		expect(targetText).toContain("nativist current.] ^p1\n\n%%menard:1 p1 5.");
		expect(targetText).toMatch(/%%menard:1 p1 5\.\w{4}\/5\.\w{4} 9\.\w{4}\/8\.\w{4} -\/8\.\w{4}%%/);
		expect(targetText).toMatch(/\^p2\n\n%%menard:1 p2 \S+ \S+%%\n/);
		expect(targetText).toMatch(/decades\.\[\^1\] \^p3\n\n%%menard:1 p3 10\.\w{4}\/9\.\w{4}%%\n/);
		expect(pendingMarkers(targetText, "align")).toEqual([]);
		expect(sourceText).toContain('translation: "[[@sarloborges1993 (EN)]]"');
		expect(targetText).toContain('source: "[[@sarloborges1993]]"');
		expect(targetText).toContain("sourceLanguage: es\ntargetLanguage: en\n");

		expect(h.ui.alignSummaries).toEqual([{ sections: 1, paired: 3, sourceOnly: 0, targetOnly: 0, doubtful: [], merged: [] }]);
		expect(h.backend.requests.filter((r) => callKind(r) === "align")).toHaveLength(2);
		expect(h.ui.summaries.at(-1)?.text).toBe("Aligned 3 of 3.");

		const model = buildPairModel({
			sourcePath: SOURCE_PATH,
			targetPath: TARGET_PATH,
			languages: { source: "es", target: "en" },
			version: 1,
			source: parseNote(sourceText, OPTIONS),
			target: parseNote(targetText, OPTIONS),
		});
		expect(reportPair(model)).toEqual({ unpairedSource: [], untranslated: [], unpairedTarget: [], pending: [], repaired: [], degraded: [], problems: [] });
	});

	it("finds the translation through the frontmatter link and changes nothing when cancelled at the preview", async () => {
		const h = createHarness();
		const linked = ALIGN_SOURCE.replace("citekey: sarloborges1993", 'citekey: sarloborges1993\ntranslation: "[[@sarloborges1993 (EN)]]"');
		const source = h.vault.add(SOURCE_PATH, linked);
		h.vault.add(TARGET_PATH, ALIGN_TARGET);
		h.ui.answers.align = false;
		await runAlign(h.deps, source, null, new AbortController());
		expect(h.ui.alignSummaries).toHaveLength(1);
		expect(h.vault.text(SOURCE_PATH)).toBe(linked);
		expect(h.vault.text(TARGET_PATH)).toBe(ALIGN_TARGET);
	});

	it("asks for the translation note when none is linked", async () => {
		const h = createHarness();
		const source = h.vault.add(SOURCE_PATH, ALIGN_SOURCE);
		await runAlign(h.deps, source, null, new AbortController());
		expect(h.ui.alignSummaries).toHaveLength(0);
		h.ui.picked = h.vault.add("Elsewhere/translation.md", ALIGN_TARGET);
		await runAlign(h.deps, source, null, new AbortController());
		expect(h.vault.text("Elsewhere/translation.md")).toContain("%%menard:1 p3 ");
	});

	it("leaves a failed unit's align marker for the next run", async () => {
		const h = createHarness({ maxRetries: 0 });
		h.backend.handler = (request) => (callKind(request) === "align" ? { groups: [] } : fakeClaude(request));
		const source = h.vault.add(SOURCE_PATH, ALIGN_SOURCE);
		const target = h.vault.add(TARGET_PATH, ALIGN_TARGET);
		await runAlign(h.deps, source, target, new AbortController());
		expect(pendingMarkers(h.vault.text(target), "align")).toEqual(["p1", "p2"]);
		expect(h.ui.summaries.at(-1)?.text).toBe("Aligned 1 of 3; 2 failed. Run Align with existing translation again to retry.");
		h.backend.handler = fakeClaude;
		await runAlign(h.deps, source, target, new AbortController());
		expect(pendingMarkers(h.vault.text(target), "align")).toEqual([]);
		expect(h.vault.text(target)).toMatch(/nativist current\.\] \^p1\n\n%%menard:1 p1 \d+\.\w{4}\/\d+\.\w{4}\?%%/);
	});
});

describe("planAlign", () => {
	it("reuses a user id on the other side and allocates fresh ids around it", () => {
		const source = "Primer párrafo del texto. ^intro\n\nSegundo párrafo del texto.\n";
		const target = "First paragraph of the text.\n\nSecond paragraph of the text. ^p1\n";
		const plan = planAlign(source, target, OPTIONS);
		expect(plan.summary.paired).toBe(2);
		expect(plan.sourceInserts.map((i) => i.text)).toEqual([" ^p1"]);
		expect(plan.targetInserts.map((i) => i.text)).toEqual([" ^intro", "\n\n%%menard:1 intro align%%", "\n\n%%menard:1 p1 align%%"]);
	});

	it("leaves a pair unpaired when its blocks already carry different ids", () => {
		const plan = planAlign("Un párrafo. ^a\n", "A paragraph. ^b\n", OPTIONS);
		expect(plan.summary).toMatchObject({ paired: 0, sourceOnly: 1, targetOnly: 1 });
		expect(plan.sourceInserts).toEqual([]);
		expect(plan.targetInserts).toEqual([]);
	});

	it("reports doubtful pairs by their first words", () => {
		const source = "## Uno\n\n> Una cita breve.\n\nUn párrafo con 1944 y Borges y Sarlo y Molloy y muchas palabras más que el otro lado tiene.\n";
		const target = "## One\n\nA list instead:\n\n- one\n\nAnother paragraph.\n";
		const plan = planAlign(source, target, OPTIONS);
		expect(plan.summary.sections).toBe(1);
		expect(plan.summary.doubtful.every((d) => d.includes(" / "))).toBe(true);
	});
});

describe("merged paragraphs (#36)", () => {
	const SOURCE = [
		"---",
		"citekey: molloyletras1979",
		"---",
		"Costumbre de Borges, de una lectura previsible.",
		"Detenerse en lo que se incorpora. ¿Qué otra cosa es leer?",
		"La superstición del texto fluido inaugura malas costumbres.",
		"Acudo a una primera persona del plural.",
		"",
	].join("\n\n").replace("---\n\ncitekey: molloyletras1979\n\n---", "---\ncitekey: molloyletras1979\n---");
	const TARGET = [
		"To read Borges has become a habit.",
		"To undo the habit, to dwell on the text: isn't that what reading is about? The promise of a flowing text gives rise to bad habits.",
		"My use of the first person plural is questionable.",
		"",
	].join("\n\n");
	const merge = { groups: [{ src: [1], tgt: [1] }, { src: [2, 3], tgt: [2] }, { src: [4], tgt: [3] }] };

	async function aligned(pairing: unknown = merge): Promise<Harness & { source: TFile; target: TFile }> {
		const h = createHarness();
		h.backend.handler = (request) => (callKind(request) === "pairing" ? pairing : fakeClaude(request));
		const source = h.vault.add(SOURCE_PATH, SOURCE);
		const target = h.vault.add(TARGET_PATH, TARGET);
		await runAlign(h.deps, source, target, new AbortController());
		return { ...h, source, target };
	}

	it("pairs by content, gives every paragraph its own id and maps the merged unit as one", async () => {
		const h = await aligned();
		const sourceText = h.vault.text(h.source);
		const targetText = h.vault.text(h.target);
		expect(unitWords(sourceText)).toEqual(unitWords(SOURCE));
		expect(unitWords(targetText)).toEqual(unitWords(TARGET));
		expect(sourceText).toMatch(/costumbres\. \^p3\n/);
		expect(targetText).toMatch(/bad habits\. \^p2\n\n%%menard:1 p2\+p3 19\.\w{4}\/27\.\w{4}\?%%\n/);
		expect(targetText).not.toMatch(/\^p3/);
		expect(h.ui.alignSummaries[0]).toMatchObject({ paired: 3, sourceOnly: 0, targetOnly: 0, merged: [expect.stringContaining(" + La superstición del texto")] });
		expect(h.backend.requests.filter((r) => callKind(r) === "pairing")).toHaveLength(1);

		const model = buildPairModel({
			sourcePath: SOURCE_PATH,
			targetPath: TARGET_PATH,
			languages: { source: "es", target: "en" },
			version: 1,
			source: parseNote(sourceText, OPTIONS),
			target: parseNote(targetText, OPTIONS),
		});
		expect(model.unit("p3")?.key).toBe("p2");
		expect(reportPair(model, parseNote(sourceText, OPTIONS))).toEqual({
			unpairedSource: [],
			untranslated: [],
			unpairedTarget: [],
			pending: [],
			repaired: [],
			degraded: [],
			problems: [],
		});

		// Translate note sees the merged paragraph as translated.
		await runTranslate(h.deps, h.source, new AbortController());
		expect(h.ui.notices.at(-1)).toBe("This note is fully translated.");
	});

	it("falls back to the length matcher when the pairing answer stays invalid", async () => {
		const h = await aligned({ groups: [{ src: [1, 2], tgt: [1, 2] }] });
		expect(h.ui.alignSummaries).toHaveLength(1);
		expect(pendingMarkers(h.vault.text(h.target), "align")).toEqual([]);
		expect(h.vault.text(h.target)).toContain("%%menard:1 p1 ");
	});

	it("re-translates a merged unit paragraph by paragraph, dissolving the merge", async () => {
		const h = await aligned();
		await runRetranslate(h.deps, { source: h.source, target: h.target }, "p2", new AbortController());
		const text = h.vault.text(h.target);
		expect(text).toMatch(/EN Detenerse en lo que se incorpora\. EN ¿Qué otra cosa es leer\? \^p2\n\n%%menard:1 p2 \S+ \S+%%\n\nEN La superstición/);
		expect(text).toMatch(/costumbres\. \^p3\n\n%%menard:1 p3 \S+%%\n/);
		expect(text).not.toContain("p2+p3");
		expect(text).not.toContain("bad habits");
	});

	it("re-aligns a merged unit, keeping its key group", async () => {
		const h = await aligned();
		await runRealign(h.deps, { source: h.source, target: h.target }, "p2", new AbortController());
		expect(h.vault.text(h.target)).toMatch(/%%menard:1 p2\+p3 19\.\w{4}\/27\.\w{4}\?%%/);
	});

	it("flags both sides instead of accepting one loose link over a long paragraph", async () => {
		const h = createHarness();
		const long = (word: string): string => `${Array.from({ length: 45 }, () => word).join(" ")}. Fin.`;
		h.backend.handler = (request) => {
			if (callKind(request) !== "align") return fakeClaude(request);
			const { source, target } = payloadOf<{ source: unknown[]; target: unknown[] }>(request);
			const all = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
			return { groups: [{ src: all(source.length), tgt: all(target.length), loose: true }] };
		};
		const source = h.vault.add(SOURCE_PATH, `${long("palabra")}\n`);
		const target = h.vault.add(TARGET_PATH, `${long("word")} Extra sentence here.\n`);
		await runAlign(h.deps, source, target, new AbortController());
		expect(h.vault.text(target)).toMatch(/%%menard:1 p1 46\.\w{4}\/- -\/49\.\w{4}%%/);
	});
});
