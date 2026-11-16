/**
 * #35: when Claude's heading translation stays invalid, Translate note keeps
 * the source headings. That fallback is logged once and shows in Report a
 * problem as headings that read the same in both notes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPairModel } from "../../src/align/model";
import { summarizeModel } from "../../src/diagnose/report";
import { runTranslate } from "../../src/jobs/translate";
import { parseNote } from "../../src/text/blocks";
import { callKind, createHarness, fakeClaude } from "./harness";
import { SOURCE_NOTE } from "./fixtures";

const OPTIONS = { textStartHeading: "", skipHeadings: ["Bibliografía"] };

async function translated(outline: unknown): Promise<string[]> {
	const h = createHarness({ skipHeadings: "Bibliografía", maxRetries: 0 });
	h.backend.handler = (request) => (callKind(request) === "outline" && outline !== null ? outline : fakeClaude(request));
	const source = h.vault.add("T/@x.md", SOURCE_NOTE);
	await runTranslate(h.deps, source, new AbortController());
	const model = buildPairModel({
		sourcePath: "T/@x.md",
		targetPath: "T/@x (EN).md",
		languages: { source: "es", target: "en" },
		version: 1,
		source: parseNote(h.vault.text(source), OPTIONS),
		target: parseNote(h.vault.text("T/@x (EN).md"), OPTIONS),
	});
	return summarizeModel(model, false).untranslatedHeadings;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("heading translation fallback (#35)", () => {
	it("keeps the source headings, logs once, and reports them as untranslated", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const keys = await translated({ headings: [] });
		expect(keys.length).toBeGreaterThan(0);
		await translated({ headings: [] });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("reports nothing when the headings were translated", async () => {
		expect(await translated(null)).toEqual([]);
	});
});
