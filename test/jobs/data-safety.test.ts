/**
 * Regression tests for the second review: writes that could pair a unit
 * with the wrong translation, misplace or duplicate markers, half-apply,
 * overwrite user edits, or leave notes the jobs can no longer pair.
 */
import { describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { isMenardError } from "../../src/errors";
import { planAlign, runAlign } from "../../src/jobs/align";
import { JobController } from "../../src/jobs/controller";
import { runRetranslate } from "../../src/jobs/retranslate";
import { pendingMarkers, runTranslate } from "../../src/jobs/translate";
import { callKind, createHarness, fakeClaude } from "./harness";
import type { Harness } from "./harness";

const SOURCE = "Texts/@x.md";
const TARGET = "Texts/@x (EN).md";
const OPTIONS = { textStartHeading: "", skipHeadings: [] };

function file(h: Harness, path: string): TFile {
	const found = h.vault.getFileByPath(path);
	if (found === null) throw new Error(`No note at ${path}`);
	return found;
}

/** Runs Translate note on the source, adding it with `text` first if it is not there yet. */
async function translate(h: Harness, text?: string): Promise<void> {
	const source = h.vault.getFileByPath(SOURCE) ?? h.vault.add(SOURCE, text ?? "");
	await runTranslate(h.deps, source, new AbortController());
}

/** Replaces `from` with `to` in a note, as the user would. */
function edit(h: Harness, path: string, from: string, to: string): void {
	const text = h.vault.text(path);
	if (!text.includes(from)) throw new Error(`“${from}” is not in ${path}`);
	h.vault.edit(file(h, path), text.replace(from, to));
}

describe("Translate note on a pair whose source changed", () => {
	it("gives a new paragraph a fresh id rather than that of a deleted paragraph whose translation remains", async () => {
		const h = createHarness();
		await translate(h, "Uno.\n\nDos.\n");
		edit(h, SOURCE, "Dos. ^p2", "Tres.");
		await translate(h);

		expect(h.vault.text(SOURCE)).toContain("Tres. ^p3\n");
		const target = h.vault.text(TARGET);
		expect(target).toContain("EN Tres. ^p3");
		expect(target).toContain("EN Dos. ^p2");
		expect(h.ui.summaries.at(-1)?.text).toBe("Translated 1 of 1.");
	});

	it("puts the translation of a new paragraph under its own heading, also before a section's first unit", async () => {
		const h = createHarness();
		await translate(h, "# A\n\nUno.\n\n## B\n\nDos.\n");
		edit(h, SOURCE, "# A\n\nUno.", "# A\n\nCero.\n\nUno.");
		edit(h, SOURCE, "## B\n\nDos.", "## B\n\nNuevo.\n\nDos.");
		await translate(h);

		const target = h.vault.text(TARGET);
		const at = (text: string): number => target.indexOf(text);
		expect(at("# EN A")).toBeLessThan(at("EN Cero."));
		expect(at("EN Cero.")).toBeLessThan(at("EN Uno."));
		expect(at("## EN B")).toBeLessThan(at("EN Nuevo."));
		expect(at("EN Nuevo.")).toBeLessThan(at("EN Dos."));
	});

	it("puts a marker after frontmatter that ends the note without a line ending on a line of its own", async () => {
		const h = createHarness();
		await translate(h, "Uno.\n");
		const frontmatter = h.vault.text(TARGET).split("\n---\n")[0] ?? "";
		h.vault.edit(file(h, TARGET), `${frontmatter}\n---`);
		await translate(h);

		expect(h.vault.text(TARGET).startsWith(`${frontmatter}\n---\nEN Uno. ^p1\n\n%%menard:1 p1 `)).toBe(true);
		expect(h.deps.pairs.resolve(file(h, TARGET))?.side).toBe("target");
	});

	it("queues no footnote marker into an unclosed code block at the end of the note, and says so", async () => {
		const h = createHarness();
		await translate(h, "Uno.\n");
		edit(h, SOURCE, "Uno. ^p1", "Uno.[^1] ^p1\n\n[^1]: Nota.");
		h.vault.edit(file(h, TARGET), `${h.vault.text(TARGET)}\n\`\`\`js\nlet x;\n`);
		const before = h.vault.text(TARGET);
		await translate(h);
		await translate(h);

		expect(h.vault.text(TARGET)).toBe(before);
		expect(h.ui.notices.filter((notice) => notice.includes("unclosed code or math block"))).toHaveLength(2);
		expect(h.backend.requests.filter((request) => callKind(request) === "plain")).toHaveLength(0);
	});

	it("says which paragraphs it skips because they share an id", async () => {
		const h = createHarness();
		await translate(h, "Uno. ^a\n\nDos. ^a\n\nTres.\n");
		expect(h.ui.notices[0]).toContain("share a key with another: ^a.");
		expect(h.vault.text(TARGET)).not.toContain("Uno");
	});

	it("resumes into a translation linked with an unquoted wikilink instead of creating another", async () => {
		const h = createHarness();
		h.vault.add(SOURCE, "---\ntranslation: [[Mi traducción]]\n---\nUno.\n");
		h.vault.add("Texts/Mi traducción.md", '---\nsource: "[[@x]]"\n---\n');
		await translate(h);

		expect(h.vault.getFileByPath(TARGET)).toBeNull();
		expect(h.vault.text(SOURCE)).toContain("translation: [[Mi traducción]]\n");
		expect(h.vault.text("Texts/Mi traducción.md")).toContain("EN Uno. ^p1");
	});

	it("trashes the note it created when the source's frontmatter cannot be written", async () => {
		const h = createHarness();
		const source = h.vault.add(SOURCE, "Uno.\n");
		vi.spyOn(h.deps.writer, "setFrontmatter").mockRejectedValueOnce(new Error("Invalid YAML"));
		await expect(runTranslate(h.deps, source, new AbortController())).rejects.toThrow("Invalid YAML");

		expect(h.vault.getFileByPath(TARGET)).toBeNull();
		expect(h.vault.trashed).toEqual([TARGET]);
	});
});

describe("Linking an existing pair", () => {
	it("leaves both notes' frontmatter alone when they already link to each other", async () => {
		const h = createHarness();
		const source = h.vault.add(SOURCE, '---\ntranslation: "[[@x (EN)]]"\n---\nUno. Dos.\n');
		h.vault.add(TARGET, '---\nsource: "[[@x]]"\nsourceLanguage: es\ntargetLanguage: en\n---\nOne. Two.\n');
		const setFrontmatter = vi.spyOn(h.deps.writer, "setFrontmatter");
		await runAlign(h.deps, source, null, new AbortController());

		expect(h.vault.text(TARGET)).toContain("One. Two. ^p1");
		expect(setFrontmatter).not.toHaveBeenCalled();
	});
});

describe("Align with existing translation", () => {
	it("writes neither note when the translation changed while the preview was open", async () => {
		const h = createHarness();
		const source = h.vault.add(SOURCE, "Uno. Dos.\n");
		const target = h.vault.add(TARGET, "One. Two.\n");
		h.ui.picked = target;
		h.ui.confirmAlign = async () => {
			h.vault.edit(target, "One. Two. Three.\n");
			return true;
		};
		const error: unknown = await runAlign(h.deps, source, null, new AbortController()).catch((e: unknown) => e);

		expect(isMenardError(error, "write-conflict")).toBe(true);
		expect(h.vault.text(source)).toBe("Uno. Dos.\n");
		expect(h.vault.text(target)).toBe("One. Two. Three.\n");
	});

	it("pairs the paragraphs when only the source has a title heading, or the translation adds a note", () => {
		const paragraphs = ["Primero aquí, con Borges.", "Segundo, en Ginebra, 1916.", "Tercero y último."];
		const translated = ["First here, with Borges.", "Second, in Geneva, 1916.", "Third and last."];
		const source = `# El Aleph\n\n${paragraphs.join("\n\n")}\n`;
		expect(planAlign(source, `${translated.join("\n\n")}\n`, OPTIONS).summary).toMatchObject({ paired: 3, sourceOnly: 0, targetOnly: 0 });
		const withNote = `${translated.join("\n\n")}\n\n## Translator's note\n\nThis translation follows the 1949 text.\n`;
		expect(planAlign(source, withNote, OPTIONS).summary).toMatchObject({ paired: 3, sourceOnly: 0, targetOnly: 1 });
	});
});

describe("Re-translate paragraph", () => {
	const pair = (h: Harness): { source: TFile; target: TFile } => ({ source: file(h, SOURCE), target: file(h, TARGET) });

	it("asks again when the translation was edited while Claude was answering, and keeps the edit on no", async () => {
		const h = createHarness();
		await translate(h, "Uno. Dos.\n");
		h.backend.handler = (request) => {
			if (callKind(request) === "translate") edit(h, TARGET, "EN Uno.", "Mine.");
			return fakeClaude(request);
		};
		h.ui.answers.replaceEdited = false;
		await runRetranslate(h.deps, pair(h), "p1", new AbortController());

		expect(h.ui.replacePreviews).toEqual(["Mine. Dos."]);
		expect(h.vault.text(TARGET)).toContain("Mine. Dos. ^p1");
		expect(h.ui.summaries.at(-1)?.text).toBe("Kept your edit of p1; the new translation was discarded.");
	});

	it("asks before replacing a list, whose edits no map can reveal", async () => {
		const h = createHarness();
		await translate(h, "- Primera edición\n- Segunda edición\n");
		h.ui.answers.replaceEdited = false;
		await runRetranslate(h.deps, pair(h), "p1", new AbortController());

		expect(h.ui.replacePreviews).toHaveLength(1);
		expect(h.backend.requests.filter((request) => callKind(request) === "plain")).toHaveLength(1);
	});
});

describe("Disabling the plugin during a job", () => {
	it("closes the progress and shows no summary from the job winding down", async () => {
		const h = createHarness();
		const source = h.vault.add(SOURCE, "Uno.\n\nDos.\n");
		const jobs = new JobController(h.deps);
		h.backend.handler = (request) => {
			jobs.dispose();
			return fakeClaude(request);
		};
		await jobs.translate(source);

		expect(h.ui.closedProgress).toBe(1);
		expect(h.ui.summaries).toEqual([]);
		expect(h.ui.notices).toEqual([]);
		expect(pendingMarkers(h.vault.text(TARGET), "translate")).toHaveLength(2);
	});
});
