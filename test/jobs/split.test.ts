import { describe, expect, it } from "vitest";
import { runSplit } from "../../src/jobs/split";
import { pendingMarkers } from "../../src/jobs/translate";
import { createHarness } from "./harness";
import { LAYOUT_B, LAYOUT_D } from "./fixtures";

const PATH = "Collections/Texts/@giordanoresistencia.md";
const TRANSLATION = "Collections/Texts/@giordanoresistencia (EN).md";
const SETTINGS = { textStartHeading: "Text", skipHeadings: "Argument, For My Work", newNoteProperties: "collection: translation" };

describe("runSplit", () => {
	it("backs up, creates the translation note, trims the source, links and aligns", async () => {
		const h = createHarness(SETTINGS);
		const file = h.vault.add(PATH, LAYOUT_B);
		await runSplit(h.deps, file, new AbortController());

		const backups = [...h.vault.adapterFiles.values()];
		expect(backups).toEqual([LAYOUT_B]);
		const source = h.vault.text(PATH);
		const translation = h.vault.text(TRANSLATION);
		expect(source).not.toContain("English translation");
		expect(source).toContain('translation: "[[@giordanoresistencia (EN)]]"');
		expect(source).toContain("# Argument\n\nThe essay argues");
		expect(translation).toMatch(/^---\nsource: "\[\[@giordanoresistencia\]\]"\nsourceLanguage: es\ntargetLanguage: en\ncollection: translation\n---\n> Resistance is not a gesture,/);
		expect(translation).toContain("Reading resists time.[^1] The text, by contrast, gives itself up. ^p");
		expect(translation).toContain("[^1]: Giordano");
		expect(pendingMarkers(translation, "align")).toEqual([]);
		expect(translation).toMatch(/%%menard:1 p\d+ \S+%%/);
		expect(h.ui.summaries.at(-1)?.text).toMatch(/^Aligned \d of \d\.$/);
	});

	it("explains a refusal and writes nothing", async () => {
		const h = createHarness({ textStartHeading: "", skipHeadings: "" });
		const file = h.vault.add("T/@borgesversiones1932.md", LAYOUT_D);
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.explained[0]?.message).toContain("no source text");
		expect(h.vault.text(file)).toBe(LAYOUT_D);
		expect(h.vault.adapterFiles.size).toBe(0);
	});

	it("refuses when the translation note already exists", async () => {
		const h = createHarness(SETTINGS);
		const file = h.vault.add(PATH, LAYOUT_B);
		h.vault.add(TRANSLATION, "Already here.\n");
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.explained[0]?.message).toContain("already exists");
		expect(h.vault.text(file)).toBe(LAYOUT_B);
	});

	it("trashes the new note when the source changed after the backup", async () => {
		const h = createHarness(SETTINGS);
		const file = h.vault.add(PATH, LAYOUT_B);
		const create = h.deps.writer.create.bind(h.deps.writer);
		h.deps.writer.create = async (path, content) => {
			const created = await create(path, content);
			h.vault.edit(file, `${LAYOUT_B}\nA line typed meanwhile.\n`);
			return created;
		};
		await runSplit(h.deps, file, new AbortController());
		expect(h.vault.trashed).toEqual([TRANSLATION]);
		expect(h.vault.text(file)).toBe(`${LAYOUT_B}\nA line typed meanwhile.\n`);
		expect(h.ui.explained[0]?.message).toContain("The note changed while writing; run again. The new note was moved to the trash");
	});

	it("does nothing when the user declines", async () => {
		const h = createHarness(SETTINGS);
		h.ui.answers.split = false;
		const file = h.vault.add(PATH, LAYOUT_B);
		await runSplit(h.deps, file, new AbortController());
		expect(h.vault.text(file)).toBe(LAYOUT_B);
		expect(h.vault.getFileByPath(TRANSLATION)).toBeNull();
	});

	it("asks for the languages and uses the confirmed ones for the new note (#25)", async () => {
		const h = createHarness(SETTINGS);
		h.ui.answers.splitLanguages = { source: "es", target: "fr" };
		const file = h.vault.add(PATH, LAYOUT_B.replace("citekey: giordanoresistencia", "citekey: giordanoresistencia\noriginalLanguage: spanish"));
		await runSplit(h.deps, file, new AbortController());
		const asked = h.ui.splitPreflights[0];
		expect(asked?.languages).toEqual({ source: "es", target: "en" });
		expect(asked?.translationPath("fr")).toBe("Collections/Texts/@giordanoresistencia (FR).md");
		expect(asked?.plan.movedFootnotes).toBe(1);
		const translation = h.vault.text("Collections/Texts/@giordanoresistencia (FR).md");
		expect(translation).toMatch(/^---\nsource: "\[\[@giordanoresistencia\]\]"\nsourceLanguage: es\ntargetLanguage: fr\n/);
		expect(h.vault.notes.has(TRANSLATION)).toBe(false);
	});

	it("passes the guessed languages of both halves to the confirmation", async () => {
		const h = createHarness({ textStartHeading: "Text", skipHeadings: "" });
		h.ui.answers.split = false;
		const english = "The translator does not copy the text; he reads it again in another tongue, and that reading is never the same as the first one. It was in this sense that the essay argued for the version as a form of criticism.";
		const spanish = "El traductor no copia el texto; lo vuelve a leer en otra lengua, y esa lectura nunca es la misma que la primera. En este sentido el ensayo defendía la versión como una forma de crítica, que tiene su propia historia.";
		const file = h.vault.add(PATH, `---\ncitekey: x\n---\n# Text\n\n${english}\n\n# English translation\n\n${spanish}\n`);
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.splitPreflights[0]).toMatchObject({ languages: { source: "es", target: "en" }, guessedSource: "en", guessedTarget: "es" });
		expect(h.vault.adapterFiles.size).toBe(0);
	});

	it("refuses the same language on both sides and writes nothing", async () => {
		const h = createHarness(SETTINGS);
		h.ui.answers.splitLanguages = { source: "en", target: "en" };
		const file = h.vault.add(PATH, LAYOUT_B);
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.explained[0]?.message).toContain("both English");
		expect(h.vault.text(file)).toBe(LAYOUT_B);
		expect(h.vault.adapterFiles.size).toBe(0);
	});

	it("refuses a confirmed target whose translation note already exists", async () => {
		const h = createHarness(SETTINGS);
		h.ui.answers.splitLanguages = { source: "es", target: "fr" };
		const file = h.vault.add(PATH, LAYOUT_B);
		h.vault.add("Collections/Texts/@giordanoresistencia (FR).md", "Ya está.\n");
		await runSplit(h.deps, file, new AbortController());
		expect(h.ui.explained[0]?.message).toContain("(FR).md” already exists");
		expect(h.vault.text(file)).toBe(LAYOUT_B);
	});
});
