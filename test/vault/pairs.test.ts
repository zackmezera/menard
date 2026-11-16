import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Component } from "obsidian";
import type { TFile } from "obsidian";
import { DEFAULT_SETTINGS, parseOptions } from "../../src/settings";
import type { MenardSettings, NoteStructure, PairModel, ParseOptions } from "../../src/types";
import type { PairModelInput } from "../../src/align/model";
import { PairStore } from "../../src/vault/pairs";
import { createFakeApp, type FakeApp } from "./fake-app";
import { SOURCE_PATH, SOURCE_TEXT, TARGET_PATH, TARGET_TEXT } from "./fixtures";

// The scanner and the model builder belong to other modules; these stand-ins
// record what PairStore hands them so the tests check the vault's own job.
vi.mock("../../src/text/blocks", () => ({
	parseNote: vi.fn((text: string, options: ParseOptions) => ({ text, options }) as unknown as NoteStructure),
}));
vi.mock("../../src/align/model", () => ({
	buildPairModel: vi.fn((input: PairModelInput) => ({ ...input, units: [], problems: [] }) as unknown as PairModel),
}));

const { parseNote } = await import("../../src/text/blocks");
const { buildPairModel } = await import("../../src/align/model");

type Built = PairModel & { source: { text: string; options: ParseOptions }; target: { text: string; options: ParseOptions } };

const SOURCE_FM = { citekey: "ruizalmotasim", translation: "[[@ruizalmotasim (EN)]]" };
const TARGET_FM = { source: "[[@ruizalmotasim]]", sourceLanguage: "es", targetLanguage: "en", collection: "translation" };

let fake: FakeApp;
let owner: Component;
let settings: MenardSettings;
let store: PairStore;
let source: TFile;
let target: TFile;

beforeEach(() => {
	vi.mocked(parseNote).mockClear();
	vi.mocked(buildPairModel).mockClear();
	fake = createFakeApp();
	owner = new Component();
	owner.load();
	settings = { ...DEFAULT_SETTINGS, textStartHeading: "Texto", skipHeadings: "Bibliografía, Notas propias" };
	store = new PairStore({ app: fake.app, settings: () => settings, owner });
	source = fake.vault.seed(SOURCE_PATH, SOURCE_TEXT, SOURCE_FM);
	target = fake.vault.seed(TARGET_PATH, TARGET_TEXT, TARGET_FM);
});

afterEach(() => {
	owner.unload();
	vi.useRealTimers();
});

describe("PairStore.resolve", () => {
	it("resolves a reciprocal pair from either note", () => {
		expect(store.resolve(source)).toEqual({ pair: { source, target }, side: "source" });
		expect(store.resolve(target)).toEqual({ pair: { source, target }, side: "target" });
	});

	it("resolves an unquoted [[link]], which YAML reads as a list holding a list", () => {
		fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: [["@ruizalmotasim (EN)"]] });
		fake.metadataCache.frontmatter.set(TARGET_PATH, { source: [["@ruizalmotasim|Ruiz"]] });
		expect(store.resolve(source)).toEqual({ pair: { source, target }, side: "source" });
		expect(store.mayBePair(SOURCE_PATH)).toBe(true);
	});

	it("gives null for a one-sided link", () => {
		fake.metadataCache.frontmatter.set(TARGET_PATH, { sourceLanguage: "es" });
		expect(store.resolve(source)).toBeNull();
		expect(store.resolve(target)).toBeNull();
	});

	it("gives null when the partner links back to a different note", () => {
		const other = fake.vault.seed("Collections/Texts/@giordanoresistencia.md", "Texto.", {});
		fake.metadataCache.frontmatter.set(TARGET_PATH, { source: "[[@giordanoresistencia]]" });
		expect(store.resolve(source)).toBeNull();
		expect(store.resolve(other)).toBeNull();
	});

	it("gives null for a web clipping whose source is a URL", () => {
		const clip = fake.vault.seed("Inbox/Reseña de Ficciones.md", "Una reseña.", {
			source: "https://www.example.org/borges/ficciones",
		});
		expect(store.resolve(clip)).toBeNull();
	});

	it("gives null for a link to a note that does not exist", () => {
		fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: "[[@ruizalmotasim (FR)]]" });
		expect(store.resolve(source)).toBeNull();
	});

	it("gives null for a note that links to itself", () => {
		fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: "[[@ruizalmotasim]]", source: "[[@ruizalmotasim]]" });
		expect(store.resolve(source)).toBeNull();
	});

	it("accepts alias and heading forms of the link", () => {
		fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: "[[@ruizalmotasim (EN)|traducción inglesa]]" });
		fake.metadataCache.frontmatter.set(TARGET_PATH, { source: "[[@ruizalmotasim#Texto]]" });
		expect(store.resolve(source)?.side).toBe("source");
		expect(store.resolve(target)?.pair.source).toBe(source);
	});

	it("accepts a heading and an alias together, and a full path", () => {
		fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: "[[Collections/Texts/@ruizalmotasim (EN)#^p1|EN]]" });
		expect(store.resolve(source)?.pair.target).toBe(target);
	});

	it("ignores values that are not a single wikilink", () => {
		for (const value of ["@ruizalmotasim (EN)", ["[[@ruizalmotasim (EN)]]"], "[[]]", "ver [[@ruizalmotasim (EN)]]", 12]) {
			fake.metadataCache.frontmatter.set(SOURCE_PATH, { translation: value });
			expect(store.resolve(source)).toBeNull();
		}
	});
});

describe("PairStore.mayBePair", () => {
	it("is true for a note with a wikilink-valued pair key, reciprocal or not", () => {
		expect(store.mayBePair(SOURCE_PATH)).toBe(true);
		fake.metadataCache.frontmatter.set(TARGET_PATH, { source: "[[@otro]]" });
		expect(store.mayBePair(TARGET_PATH)).toBe(true);
	});

	it("is false for plain notes, web clippings and unknown paths", () => {
		fake.vault.seed("Collections/Notes/metalepsis.md", "Genette (1972).", { tags: ["narratología"] });
		fake.vault.seed("Inbox/clip.md", "Recorte.", { source: "https://example.org" });
		expect(store.mayBePair("Collections/Notes/metalepsis.md")).toBe(false);
		expect(store.mayBePair("Inbox/clip.md")).toBe(false);
		expect(store.mayBePair("no/existe.md")).toBe(false);
	});
});

describe("PairStore.load", () => {
	it("builds the model from both notes with the right options and languages", async () => {
		const model = (await store.load(source)) as Built;

		expect(model.sourcePath).toBe(SOURCE_PATH);
		expect(model.targetPath).toBe(TARGET_PATH);
		expect(model.version).toBe(1);
		expect(model.languages).toEqual({ source: "es", target: "en" });
		expect(model.source).toEqual({ text: SOURCE_TEXT, options: parseOptions(settings) });
		expect(model.target).toEqual({
			text: TARGET_TEXT,
			options: { textStartHeading: "", skipHeadings: ["Bibliografía", "Notas propias"] },
		});
		expect(fake.vault.cachedReads.sort()).toEqual([SOURCE_PATH, TARGET_PATH].sort());
	});

	it("falls back to the default languages", async () => {
		fake.metadataCache.frontmatter.set(TARGET_PATH, { source: "[[@ruizalmotasim]]", targetLanguage: "  " });
		settings = { ...settings, defaultSourceLanguage: "it", defaultTargetLanguage: "de" };
		expect((await store.load(target))?.languages).toEqual({ source: "it", target: "de" });
	});

	it("caches the model under both paths", async () => {
		const model = await store.load(target);
		expect(store.peek(SOURCE_PATH)).toBe(model);
		expect(store.peek(TARGET_PATH)).toBe(model);
		expect(await store.load(source)).toBe(model);
		expect(buildPairModel).toHaveBeenCalledTimes(1);
	});

	it("shares one build between concurrent loads", async () => {
		const [a, b] = await Promise.all([store.load(source), store.load(target)]);
		expect(a).toBe(b);
		expect(buildPairModel).toHaveBeenCalledTimes(1);
	});

	it("gives null for a note that is not in a pair", async () => {
		const note = fake.vault.seed("Collections/Notes/metalepsis.md", "Genette (1972).", {});
		expect(await store.load(note)).toBeNull();
		expect(store.peek(note.path)).toBeNull();
	});

	it("peek gives null before a build", () => {
		expect(store.peek(SOURCE_PATH)).toBeNull();
	});
});

describe("PairStore change tracking", () => {
	/** Lets the rebuild's awaited reads settle under fake timers. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	beforeEach(() => {
		vi.useFakeTimers();
		store.start();
	});

	it("rebuilds an open pair 250 ms after the last change and notifies listeners", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);

		const revised = TARGET_TEXT.replace("# Text", "# Text\n\nA translator's note on «reseñar».");
		fake.vault.edit(target, revised);
		fake.metadataCache.changed(target);
		await vi.advanceTimersByTimeAsync(100);
		fake.metadataCache.changed(target);
		await vi.advanceTimersByTimeAsync(249);
		await settle();
		expect(listener).not.toHaveBeenCalled();
		expect(store.peek(SOURCE_PATH)?.version).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith(SOURCE_PATH);
		const model = store.peek(TARGET_PATH) as Built;
		expect(model.version).toBe(2);
		expect(model.target.text).toBe(revised);
	});

	it("serves a fresh model from load while a rebuild is pending", async () => {
		await store.load(source);
		fake.vault.edit(source, `${SOURCE_TEXT}Párrafo nuevo.\n`);
		fake.metadataCache.changed(source);
		const fresh = (await store.load(source)) as Built;
		expect(fresh.version).toBe(2);
		expect(fresh.source.text).toContain("Párrafo nuevo.");
	});

	it("never serves or caches a build that read the notes before a later change", async () => {
		await store.load(source);
		fake.vault.edit(source, `${SOURCE_TEXT}Primera revisión.\n`);
		fake.metadataCache.changed(source);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const read = vi.spyOn(fake.vault, "cachedRead").mockImplementation(async (file) => {
			const text = fake.vault.text(file);
			await gate;
			return text;
		});
		const stale = store.load(source);
		await settle();
		read.mockRestore();

		fake.vault.edit(source, `${SOURCE_TEXT}Segunda revisión.\n`);
		fake.metadataCache.changed(source);
		const fresh = (await store.load(source)) as Built;
		release();
		await stale;

		expect(fresh.source.text).toContain("Segunda revisión.");
		expect((store.peek(SOURCE_PATH) as Built).source.text).toContain("Segunda revisión.");
	});

	it("drops a model whose rebuild failed, so the next load builds again", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);
		vi.mocked(buildPairModel).mockImplementationOnce(() => {
			throw new Error("model bug");
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

		fake.metadataCache.changed(source);
		await vi.advanceTimersByTimeAsync(250);
		await settle();

		expect(log).toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
		expect(store.peek(SOURCE_PATH)).toBeNull();
		expect((await store.load(source))?.version).toBe(3);
		log.mockRestore();
	});

	it("ignores changes to notes outside open pairs", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		fake.metadataCache.changed(source);
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(listener).not.toHaveBeenCalled();
		expect(buildPairModel).not.toHaveBeenCalled();
	});

	it("drops the pair and notifies when the link back is removed", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);

		fake.metadataCache.setFrontmatter(target, { sourceLanguage: "es" });
		await vi.advanceTimersByTimeAsync(250);
		await settle();

		expect(listener).toHaveBeenCalledWith(SOURCE_PATH);
		expect(store.peek(SOURCE_PATH)).toBeNull();
		expect(store.peek(TARGET_PATH)).toBeNull();
	});

	it("forgets a deleted note at once and notifies after the debounce", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);

		fake.vault.delete(target);
		expect(store.peek(SOURCE_PATH)).toBeNull();
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(listener).toHaveBeenCalledWith(SOURCE_PATH);
	});

	it("follows a renamed source note", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);

		fake.vault.rename(source, "Collections/Texts/@ruizalmotasim2002.md");
		fake.metadataCache.frontmatter.set(TARGET_PATH, { ...TARGET_FM, source: "[[@ruizalmotasim2002]]" });
		expect(store.peek("Collections/Texts/@ruizalmotasim2002.md")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(250);
		await settle();

		expect(listener).toHaveBeenCalledWith("Collections/Texts/@ruizalmotasim2002.md");
		const model = store.peek(TARGET_PATH);
		expect(model?.sourcePath).toBe("Collections/Texts/@ruizalmotasim2002.md");
		expect(model?.version).toBe(2);
		expect(store.peek(SOURCE_PATH)).toBeNull();
	});

	it("stops notifying an unsubscribed listener", async () => {
		const listener = vi.fn();
		const unsubscribe = store.onChange(listener);
		await store.load(source);
		unsubscribe();
		fake.metadataCache.changed(source);
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(listener).not.toHaveBeenCalled();
	});

	it("stops listening when the owner unloads", async () => {
		await store.load(source);
		owner.unload();
		fake.metadataCache.changed(source);
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(store.peek(SOURCE_PATH)?.version).toBe(1);
	});

	it("rebuilds every cached pair when a model setting changes, and notifies listeners (#27)", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);
		settings = { ...settings, textStartHeading: "Text" };
		store.settingsChanged();
		const fresh = (await store.load(target)) as Built;
		expect(fresh.version).toBe(2);
		expect(fresh.source.options.textStartHeading).toBe("Text");
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(listener).toHaveBeenCalledWith(SOURCE_PATH);
		expect((store.peek(SOURCE_PATH) as Built).source.options.textStartHeading).toBe("Text");
	});

	it("leaves cached pairs alone when no model setting changed", async () => {
		const listener = vi.fn();
		store.onChange(listener);
		await store.load(source);
		settings = { ...settings, revealMode: !settings.revealMode, backupCount: 5 };
		store.settingsChanged();
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(listener).not.toHaveBeenCalled();
		expect(store.peek(SOURCE_PATH)?.version).toBe(1);
	});

	it("rebuilds on invalidateAll even when the settings did not change", async () => {
		await store.load(source);
		store.invalidateAll();
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(store.peek(SOURCE_PATH)?.version).toBe(2);
	});
});
