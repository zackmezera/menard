import { describe, expect, it } from "vitest";
import { buildPairModel } from "../../src/align/model";
import { MenardError } from "../../src/errors";
import { reportPair } from "../../src/jobs/check";
import { pendingMarkers, runTranslate } from "../../src/jobs/translate";
import { parseNote } from "../../src/text/blocks";
import { callKind, createHarness, fakeClaude, payloadOf } from "./harness";
import type { Harness } from "./harness";
import { SOURCE_NOTE } from "./fixtures";

const SOURCE_PATH = "Collections/Texts/@perezlaberinto2019.md";
const TARGET_PATH = "Collections/Texts/@perezlaberinto2019 (EN).md";
const OPTIONS = { textStartHeading: "", skipHeadings: ["Bibliografía"] };

async function translate(h: Harness): Promise<AbortController> {
	const controller = new AbortController();
	const source = h.vault.getFileByPath(SOURCE_PATH) ?? h.vault.add(SOURCE_PATH, SOURCE_NOTE);
	await runTranslate(h.deps, source, controller);
	return controller;
}

/** Text of a full, uninterrupted run, for comparison. */
async function referenceRun(): Promise<{ source: string; target: string }> {
	const h = createHarness({ skipHeadings: "Bibliografía" });
	await translate(h);
	return { source: h.vault.text(SOURCE_PATH), target: h.vault.text(TARGET_PATH) };
}

function report(h: Harness): ReturnType<typeof reportPair> {
	return reportPair(
		buildPairModel({
			sourcePath: SOURCE_PATH,
			targetPath: TARGET_PATH,
			languages: { source: "es", target: "en" },
			version: 1,
			source: parseNote(h.vault.text(SOURCE_PATH), OPTIONS),
			target: parseNote(h.vault.text(TARGET_PATH), { textStartHeading: "", skipHeadings: [] }),
		}),
	);
}

const ENGLISH_NOTE = `---
citekey: borgesversiones1932
---
# Las versiones homéricas

🔗 [Open in Zotero](zotero://select/library/items/ABCD1234)

# Text

No problem is as consubstantial with literature and its modest mystery as the one that a translation raises. The forgetting that is caused by vanity, the fear of confessing mental processes that we suspect are dangerously ordinary, and the attempt to keep intact an incalculable reserve of shadow all have a part in it.
`;

describe("runTranslate: languages (#25)", () => {
	const withProperty = (value: string): string => SOURCE_NOTE.replace("citekey: perezlaberinto2019", `citekey: perezlaberinto2019\noriginalLanguage: ${value}`);

	it("warns through the preflight when the text does not look like the default source language", async () => {
		const h = createHarness();
		h.ui.answers.translate = false;
		h.vault.add(SOURCE_PATH, ENGLISH_NOTE);
		await translate(h);
		expect(h.ui.preflights[0]).toMatchObject({ languages: { source: "es", target: "en" }, guessedSource: "en" });
		expect(h.ui.preflights[0]?.firstUnit).toMatch(/^No problem is as consubstantial/);
		expect(h.vault.notes.has(TARGET_PATH)).toBe(false);
	});

	it("proposes the source language from an originalLanguage property", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.ui.answers.translate = false;
		h.vault.add(SOURCE_PATH, withProperty("french"));
		await translate(h);
		expect(h.ui.preflights[0]?.languages).toEqual({ source: "fr", target: "en" });
		expect(h.ui.preflights[0]?.guessedSource).toBe("es");
	});

	it("proposes the reverse direction for a note already in the target language", async () => {
		const h = createHarness();
		h.ui.answers.translate = false;
		h.vault.add(SOURCE_PATH, ENGLISH_NOTE.replace("citekey: borgesversiones1932", "citekey: borgesversiones1932\noriginalLanguage: english"));
		await translate(h);
		expect(h.ui.preflights[0]?.languages).toEqual({ source: "en", target: "es" });
	});

	it("makes no guess on a note that matches its language", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.ui.answers.translate = false;
		h.vault.add(SOURCE_PATH, withProperty("spanish"));
		await translate(h);
		expect(h.ui.preflights[0]?.languages.source).toBe("es");
	});

	it("refuses when source and target are the same language, and writes nothing", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.ui.answers.languages = { source: "en", target: "en-GB" };
		h.vault.add(SOURCE_PATH, SOURCE_NOTE);
		await translate(h);
		expect(h.ui.explained[0]?.message).toContain("both English");
		expect(h.vault.text(SOURCE_PATH)).toBe(SOURCE_NOTE);
		expect(h.vault.notes.has(TARGET_PATH)).toBe(false);
		expect(h.backend.requests).toHaveLength(0);
	});
});

describe("runTranslate", () => {
	it("leaves a Zotero link, buttons and a base embed before the text untranslated by default (#26)", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		const preamble = "🔗 [Open in Zotero](zotero://select/library/items/ABCD1234)\n`BUTTON[open-pdf]`\n\n![[Text.base]]\n\n";
		h.vault.add(SOURCE_PATH, SOURCE_NOTE.replace("---\n# El laberinto", `---\n${preamble}# El laberinto`));
		await translate(h);
		const source = h.vault.text(SOURCE_PATH);
		expect(source).toContain(`---\n${preamble}# El laberinto como forma\n`);
		expect(h.vault.text(TARGET_PATH)).not.toContain("Zotero");
		expect(h.ui.preflights[0]).toMatchObject({ units: 6, idsToAdd: 5 });
	});

	it("translates a note end to end: ids, outline, skeleton, units, maps and links", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía", newNoteProperties: "collection: translation" });
		await translate(h);

		const source = h.vault.text(SOURCE_PATH);
		expect(source).toContain("«La muerte y la brújula». ^p1\n");
		expect(source).toContain("> dijo el Señor.\n\n^p2\n");
		expect(source).toContain("(Molloy 1979, 42). ^p3\n");
		expect(source).toContain("- Segunda edición: Emecé, 1956\n\n^p4\n");
		expect(source).toContain("> La primera edición es de 1944. Fue revisada en 1956.\n\n^p5\n");
		expect(source).toContain('translation: "[[@perezlaberinto2019 (EN)]]"');
		expect(source).toContain("Borges, J. L. *Ficciones*. Buenos Aires: Sur, 1944.\n");

		const target = h.vault.text(TARGET_PATH);
		expect(target).toMatch(/^---\nsource: "\[\[@perezlaberinto2019\]\]"\nsourceLanguage: es\ntargetLanguage: en\ncollection: translation\n---\n# EN El laberinto como forma\n\n/);
		expect(target).toContain(
			"EN Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.[^1] EN Esa lectura, dice, fue decisiva para «La muerte y la brújula». ^p1\n\n%%menard:1 p1 ",
		);
		expect(target).toContain("> EN «Yo soy el que soy»,\n> EN dijo el Señor.\n\n^p2\n\n%%menard:1 p2 ");
		expect(target).toContain("EN El narrador de [[Ficciones]] no describe el laberinto: lo *recorre*.");
		expect(target).toContain("- Primera edition: Sur, 1944\n- Segunda edition: Emecé, 1956\n\n^p4\n");
		expect(target).toContain("> [!note] EN Nota del editor\n> EN La primera edición es de 1944. EN Fue revisada en 1956.\n\n^p5\n\n%%menard:1 p5 ");
		expect(target).toContain("[^1]: Véase la carta a Abramowicz, p. 12.");
		expect(target).not.toContain("Bibliografía");
		expect(pendingMarkers(target, "translate")).toEqual([]);

		expect(report(h)).toEqual({ unpairedSource: [], untranslated: [], unpairedTarget: [], pending: [], repaired: [], degraded: [], problems: [] });
		expect(h.deps.pairs.resolve(h.vault.getFileByPath(SOURCE_PATH) as never)?.side).toBe("source");
		expect(h.ui.preflights[0]).toMatchObject({ units: 6, idsToAdd: 5, skippedSections: ["Bibliografía"], resume: false });
		expect(h.ui.preflights[0]?.firstUnit).toMatch(/^Según el Sr\. Pérez \(cf\. pp\. 23-25\), .{20,}…$/);
		expect(h.ui.summaries.at(-1)?.text).toBe("Translated 6 of 6.");
		h.ui.summaries.at(-1)?.action?.run();
		expect(h.opened).toEqual([SOURCE_PATH]);
	});

	it("sends the previous unit as context and the protected sentences", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		await translate(h);
		const calls = h.backend.requests.filter((r) => callKind(r) === "translate");
		const first = payloadOf<{ sentences: { text: string }[]; context?: unknown }>(calls[0] as never);
		expect(first.sentences.map((s) => s.text)).toEqual([
			"Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.⟦^1⟧ ",
			"Esa lectura, dice, fue decisiva para «La muerte y la brújula».",
		]);
		expect(first.context).toBeUndefined();
		const second = payloadOf<{ context?: { source: string; translation?: string } }>(calls[1] as never);
		expect(second.context?.source).toContain("Esa lectura, dice, fue decisiva");
		expect(second.context?.translation).toContain("EN Esa lectura");
		expect(calls[0]?.model).toBe("sonnet");
		expect(calls[0]?.timeoutMs).toBe(180_000);
	});

	it("leaves translate markers when cancelled midway, and a second run completes the same text", async () => {
		const reference = await referenceRun();
		const h = createHarness({ skipHeadings: "Bibliografía" });
		let controller: AbortController | null = null;
		h.backend.handler = (request, call) => {
			if (call === 4) controller?.abort();
			return fakeClaude(request);
		};
		const source = h.vault.add(SOURCE_PATH, SOURCE_NOTE);
		controller = new AbortController();
		await runTranslate(h.deps, source, controller);

		const partial = h.vault.text(TARGET_PATH);
		expect(pendingMarkers(partial, "translate")).toEqual(["p3", "p4", "p5", "fn:1"]);
		expect(h.ui.summaries.at(-1)?.text).toBe("Translation cancelled: 2 of 6 written. Run Translate note again to resume.");

		h.backend.handler = fakeClaude;
		await runTranslate(h.deps, source, new AbortController());
		expect(h.ui.preflights.at(-1)).toMatchObject({ resume: true, units: 4, idsToAdd: 0 });
		expect(h.vault.text(TARGET_PATH)).toBe(reference.target);
		expect(h.vault.text(SOURCE_PATH)).toBe(reference.source);
	});

	it("gives identical text when units finish out of order", async () => {
		const reference = await referenceRun();
		const h = createHarness({ skipHeadings: "Bibliografía", concurrency: 4 });
		let order = 0;
		h.backend.handler = async (request) => {
			const delay = callKind(request) === "outline" ? 0 : 40 - 8 * order++;
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
			return fakeClaude(request);
		};
		const finished: string[] = [];
		const write = h.deps.writer.rewriteOwned.bind(h.deps.writer);
		h.deps.writer.rewriteOwned = (file, compute) =>
			write(file, (text) => {
				const result = compute(text);
				if (result !== "noop" && result !== "conflict") finished.push(...result.map((r) => r.expect));
				return result;
			});
		await translate(h);
		const keys = finished.map((marker) => marker.split(" ")[1]);
		expect(keys).toHaveLength(6);
		expect(keys).not.toEqual(["p1", "p2", "p3", "p4", "p5", "fn:1"]);
		expect(h.vault.text(TARGET_PATH)).toBe(reference.target);
	});

	it("retries an invalid answer with feedback, then fails the unit and keeps its marker", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.backend.handler = (request) => {
			const output = fakeClaude(request) as { groups?: { markdown: string }[] };
			if (callKind(request) === "translate" && request.prompt.includes("[[Ficciones]]")) {
				return { groups: output.groups?.map((g) => ({ ...g, markdown: g.markdown.replace("[[Ficciones]]", "Fictions") })) };
			}
			return output;
		};
		await translate(h);

		const attempts = h.backend.requests.filter((r) => r.prompt.includes("[[Ficciones]]"));
		expect(attempts).toHaveLength(3);
		expect(attempts[0]?.prompt).not.toContain("Your previous answer was rejected");
		expect(attempts[1]?.prompt).toContain("Your previous answer was rejected: wikilink [[Ficciones]] missing. Return corrected JSON.");
		expect(pendingMarkers(h.vault.text(TARGET_PATH), "translate")).toEqual(["p3"]);
		expect(h.ui.summaries.at(-1)?.text).toBe("Translated 5 of 6; 1 failed. Run Translate note again to retry.");
	});

	it("retries a crashed call once before failing the unit", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		let crashes = 0;
		h.backend.handler = (request) => {
			if (callKind(request) === "plain" && crashes++ === 0) throw new MenardError("cli-crash", "exit 1");
			return fakeClaude(request);
		};
		await translate(h);
		expect(crashes).toBe(3);
		expect(h.ui.summaries.at(-1)?.text).toBe("Translated 6 of 6.");
	});

	it("stops the whole job when Claude Code is not signed in, keeping what was written", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.backend.handler = (request, call) => {
			if (call === 3) throw new MenardError("cli-not-logged-in", "Not logged in");
			return fakeClaude(request);
		};
		await translate(h);
		expect(pendingMarkers(h.vault.text(TARGET_PATH), "translate")).toEqual(["p2", "p3", "p4", "p5", "fn:1"]);
		expect(h.backend.requests).toHaveLength(3);
		expect(h.ui.summaries.at(-1)?.text).toBe(
			"Claude Code is not signed in for apps started outside a terminal. Run `claude` once in a terminal and sign in, then try again. 1 of 6 written.",
		);
	});

	it("reports a usage limit with the resume hint", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		h.backend.handler = (request, call) => {
			if (call === 2) throw new MenardError("cli-rate-limited", "limit");
			return fakeClaude(request);
		};
		await translate(h);
		expect(h.ui.summaries.at(-1)?.text).toBe("Claude usage limit reached. 0 of 6 written; run Translate note later to resume.");
	});

	it("inserts markers for new source units into an existing translation, after their predecessor", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		await translate(h);
		const source = h.vault.getFileByPath(SOURCE_PATH);
		if (source === null) throw new Error("no source");
		h.vault.edit(source, h.vault.text(source).replace("(Molloy 1979, 42). ^p3\n", "(Molloy 1979, 42). ^p3\n\nUn párrafo nuevo, escrito después.\n"));
		await runTranslate(h.deps, source, new AbortController());
		const target = h.vault.text(TARGET_PATH);
		expect(target).toMatch(/\^p3\n\n%%menard:1 p3 [^\n]+%%\n\nEN Un párrafo nuevo, escrito después\. \^p6\n\n%%menard:1 p6 [^\n]+%%\n\n- Primera/);
		expect(h.ui.preflights.at(-1)).toMatchObject({ resume: true, units: 1, idsToAdd: 1 });
	});

	it("refuses an existing translation note that is not linked back", async () => {
		const h = createHarness();
		h.vault.add(TARGET_PATH, "Some English text.\n");
		await translate(h);
		expect(h.ui.explained[0]?.message).toContain("already exists but is not linked to this note");
		expect(h.backend.requests).toHaveLength(0);
	});

	it("does nothing when the user cancels the preflight or Claude Code is missing", async () => {
		const h = createHarness();
		h.ui.answers.translate = false;
		await translate(h);
		expect(h.vault.text(SOURCE_PATH)).toBe(SOURCE_NOTE);
		expect(h.vault.getFileByPath(TARGET_PATH)).toBeNull();

		const missing = createHarness();
		missing.deps.detect = async () => ({ path: null, via: null, tried: [] });
		await translate(missing);
		expect(missing.ui.notices).toEqual(["Claude Code was not found. Set its path in Menard's options."]);
		expect(missing.ui.preflights).toHaveLength(0);
	});
});
