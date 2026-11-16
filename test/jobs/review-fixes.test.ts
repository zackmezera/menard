// @vitest-environment happy-dom
import "./dom-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { planAlign, runAlign } from "../../src/jobs/align";
import { runCheck } from "../../src/jobs/check";
import type { StartJob } from "../../src/jobs/controller";
import { canonicalLanguage, languageCode } from "../../src/jobs/modals";
import { ProgressNotice } from "../../src/jobs/progress";
import { runSplit } from "../../src/jobs/split";
import { planSplit } from "../../src/jobs/split-plan";
import { keyedUnits, lineInsertAfter, pendingMarkers, runTranslate } from "../../src/jobs/translate";
import { parseNote } from "../../src/text/blocks";
import { applyInserts, lineStarts } from "../../src/text/edits";
import { callKind, createHarness, fakeClaude } from "./harness";
import { ALIGN_SOURCE, ALIGN_TARGET, LAYOUT_B, SOURCE_NOTE } from "./fixtures";

const OPTIONS = { textStartHeading: "", skipHeadings: [] };

describe("Menard lines never join the next block", () => {
	it("leaves a blank line after a marker when text follows directly", () => {
		const text = "Uno. ^p1\n## Dos\n";
		const insert = lineInsertAfter(text, lineStarts(text), 0, "%%menard:1 p1 align%%", false);
		expect(applyInserts(text, [insert])).toBe("Uno. ^p1\n\n%%menard:1 p1 align%%\n\n## Dos\n");
	});

	it("adds nothing after a marker at the end of the note or before a blank line", () => {
		const atEnd = "Uno. ^p1";
		expect(applyInserts(atEnd, [lineInsertAfter(atEnd, lineStarts(atEnd), 0, "%%m%%", false)])).toBe("Uno. ^p1\n\n%%m%%");
		const beforeBlank = "Uno. ^p1\n\nDos.\n";
		expect(applyInserts(beforeBlank, [lineInsertAfter(beforeBlank, lineStarts(beforeBlank), 0, "%%m%%", false)])).toBe("Uno. ^p1\n\n%%m%%\n\nDos.\n");
	});

	it("puts align markers after new own-line ids with blank lines on both sides, before a heading", () => {
		const source = "Una frase. Otra frase.\n\n## Sección\n\n> Tres. Cuatro.\n";
		const target = "One sentence. Another sentence.\n## Section\n\n> Three. Four.\n## End\n\nTail.\n";
		const plan = planAlign(source, target, OPTIONS);
		const written = applyInserts(target, plan.targetInserts);
		expect(written).toContain("Another sentence. ^p1\n\n%%menard:1 p1 align%%\n\n## Section\n");
		expect(written).toContain("> Three. Four.\n\n^p2\n\n%%menard:1 p2 align%%\n\n## End\n");
		const menardBlocks = parseNote(written, OPTIONS).blocks.filter((block) => block.kind === "menard");
		expect(menardBlocks.map((block) => block.raw)).toEqual(["%%menard:1 p1 align%%", "%%menard:1 p2 align%%"]);
	});
});

describe("ambiguous keys", () => {
	it("drops units whose key another unit shares, so neither is written in the other's place", () => {
		const text = "Uno. ^a\n\nDos. ^a\n\nTres. ^b\n\nRef.[^3] Ref.[^en-3]\n\n[^3]: Nota.\n\n[^en-3]: Otra nota.\n";
		expect(keyedUnits(parseNote(text, OPTIONS)).map((unit) => unit.key)).toEqual(["b"]);
	});

	it("translates neither of two footnotes that pair alike, and counts only what it can translate", async () => {
		const h = createHarness();
		const source = h.vault.add("Texts/@x.md", "Primera frase.[^3] Segunda.[^en-3]\n\n[^3]: Nota uno.\n\n[^en-3]: Nota dos.\n");
		await runTranslate(h.deps, source, new AbortController());
		const target = h.vault.text("Texts/@x (EN).md");
		expect(target).not.toContain("fn:3");
		expect(target).not.toContain("Nota uno");
		expect(h.ui.preflights[0]?.units).toBe(1);
		expect(h.ui.summaries.at(-1)?.text).toBe("Translated 1 of 1.");
	});
});

describe("Translate note with an edited target language", () => {
	it("refuses before writing when the note for the chosen language already exists unlinked", async () => {
		const h = createHarness({ skipHeadings: "Bibliografía" });
		const source = h.vault.add("Texts/@x.md", SOURCE_NOTE);
		h.vault.add("Texts/@x (FR).md", "Une traduction faite à la main.\n");
		h.ui.answers.languages = { source: "es", target: "fr" };
		await runTranslate(h.deps, source, new AbortController());
		expect(h.ui.explained[0]?.message).toContain("“Texts/@x (FR).md” already exists");
		expect(h.vault.text(source)).toBe(SOURCE_NOTE);
		expect(h.backend.requests).toHaveLength(0);
	});
});

describe("Align partner checks", () => {
	it("refuses to take another pair's translation as this note's translation", async () => {
		const h = createHarness();
		h.vault.add("Texts/@other.md", 'translation: "[[@shared (EN)]]"\n');
		const other = '---\nsource: "[[@other]]"\n---\n';
		const partner = h.vault.add("Texts/@shared (EN).md", other + ALIGN_TARGET.replace(/^---\n[\s\S]*?\n---\n/, ""));
		const source = h.vault.add("Texts/@x.md", ALIGN_SOURCE);
		const before = h.vault.text(partner);
		h.ui.picked = partner;
		await runAlign(h.deps, source, null, new AbortController());
		expect(h.ui.explained[0]?.message).toBe("“@shared (EN)” is already the translation of “@other”.");
		expect(h.vault.text(partner)).toBe(before);
		expect(h.vault.text(source)).toBe(ALIGN_SOURCE);
	});

	it("refuses to align a note with itself or with a source note", async () => {
		const h = createHarness();
		const source = h.vault.add("Texts/@x.md", ALIGN_SOURCE);
		h.ui.picked = source;
		await runAlign(h.deps, source, null, new AbortController());
		h.vault.add("Texts/@y (EN).md", "Text.\n");
		const otherSource = h.vault.add("Texts/@y.md", '---\ntranslation: "[[@y (EN)]]"\n---\nTexto.\n');
		h.ui.picked = otherSource;
		await runAlign(h.deps, source, null, new AbortController());
		expect(h.ui.explained.map((e) => e.message)).toEqual([
			"A note cannot be aligned with itself. Choose its translation note.",
			"“@y” is the source of another pair, so it cannot be this note's translation.",
		]);
		expect(h.vault.text(source)).toBe(ALIGN_SOURCE);
	});
});

describe("Split", () => {
	it("keeps the translation's footnotes after its text even when a definition stands before the boundary", () => {
		const text = "# Texto\n\nUno.[^1]\n\n[^en-1]: Note one.\n\n# English translation\n\nOne.[^en-1]\n\n[^1]: Nota uno.\n";
		const result = planSplit(text, "English translation", OPTIONS);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.translationBody).toBe("One.[^1]\n\n[^1]: Note one.\n");
		expect(result.plan.sourceText).toBe("# Texto\n\nUno.[^1]\n\n[^1]: Nota uno.\n");
	});

	it("refuses a note that is already part of a pair", async () => {
		const h = createHarness({ textStartHeading: "Text", skipHeadings: "Argument" });
		const linked = LAYOUT_B.replace("---\n", '---\ntranslation: "[[@elsewhere]]"\n');
		h.vault.add("Texts/@elsewhere.md", "Elsewhere.\n");
		const file = h.vault.add("Texts/@g.md", linked);
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.explained[0]?.message).toBe("This note is already part of a pair, so it cannot be split. Run Check alignment instead.");
		expect(h.vault.text(file)).toBe(linked);
	});
});

describe("Check alignment's Resume", () => {
	it("runs the align markers when only align markers are waiting", async () => {
		const h = createHarness();
		const source = h.vault.add("Texts/@x.md", ALIGN_SOURCE);
		const target = h.vault.add("Texts/@x (EN).md", ALIGN_TARGET);
		h.backend.handler = (request) => {
			if (callKind(request) === "align") throw new Error("not yet");
			return fakeClaude(request);
		};
		await runAlign(h.deps, source, target, new AbortController());
		expect(pendingMarkers(h.vault.text(target), "align").length).toBeGreaterThan(0);

		h.backend.handler = fakeClaude;
		const jobs: Promise<void>[] = [];
		const start: StartJob = (work) => {
			const job = work(new AbortController());
			jobs.push(job);
			return job;
		};
		await runCheck(h.deps, source, start);
		const resume = h.ui.reports.at(-1)?.actions.resume;
		expect(resume).toBeDefined();
		resume?.();
		await Promise.all(jobs);
		expect(pendingMarkers(h.vault.text(target), "align")).toEqual([]);
		expect(h.ui.notices).not.toContain("This note is fully translated.");
	});
});

describe("ProgressNotice after the user dismisses it", () => {
	afterEach(() => {
		vi.useRealTimers();
		document.body.empty();
	});

	it("shows a new notice instead of updating the dismissed one, so the summary is seen", () => {
		vi.useFakeTimers();
		const progress = new ProgressNotice("Translating @x", () => undefined, null);
		progress.update(0, 0, 1, 2);
		const first = Reflect.get(progress, "notice") as Notice;
		first.containerEl = document.body.createDiv();
		vi.advanceTimersByTime(300);
		progress.update(1, 0, 1, 2);
		expect(Reflect.get(progress, "notice")).toBe(first);

		first.containerEl.remove();
		progress.finish("Translated 2 of 2.");
		const second = Reflect.get(progress, "notice") as Notice;
		expect(second).not.toBe(first);
		expect((second as unknown as { message: DocumentFragment }).message.textContent).toBe("Translated 2 of 2.");
	});
});

describe("language fields of the preflight", () => {
	it("accepts BCP 47 tags in canonical form and rejects anything else", () => {
		expect(canonicalLanguage(" ES ")).toBe("es");
		expect(canonicalLanguage("pt-br")).toBe("pt-BR");
		expect(canonicalLanguage("")).toBeNull();
		expect(canonicalLanguage("e")).toBeNull();
		expect(canonicalLanguage("Spanish!")).toBeNull();
	});

	it("marks an invalid field for assistive technology", () => {
		const input = document.createElement("input");
		input.value = "x";
		expect(languageCode(input)).toBeNull();
		expect(input.getAttribute("aria-invalid")).toBe("true");
		input.value = "en";
		expect(languageCode(input)).toBe("en");
		expect(input.getAttribute("aria-invalid")).toBe("false");
	});
});
