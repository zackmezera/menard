/**
 * Private regression check for adaptations (`npm run field`): for every
 * folder in fixtures-private/ holding source.md, translation.md and
 * expected.json, runs the real Align (paragraph pairing and sentence pass)
 * through the real claude CLI and reports expected against actual pairing,
 * flagged and loose links, and text drift. The fixtures are copyrighted
 * texts and never enter the repo (fixtures-private/ is gitignored).
 *
 * expected.json: { "settings"?: Partial<MenardSettings>, "pairs": [{ "source": ["first words", …], "target": ["first words", …] }] }
 * One entry per paired unit, each side listing the first words of its paragraphs in order (two or more: a merged unit).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unitBlocks, buildPairModel } from "../../src/align/model";
import { wordsOf } from "../../src/align/words";
import { runAlign } from "../../src/jobs/align";
import { ClaudeCliBackend } from "../../src/llm/claude-cli";
import { parseOptions } from "../../src/settings";
import { parseNote, textUnits } from "../../src/text/blocks";
import { projectMarkdown } from "../../src/text/inline";
import type { MenardSettings, PairModel } from "../../src/types";
import { createHarness } from "../jobs/harness";
import { stripMenard } from "./strip";

/** MENARD_FIELD_FIXTURES: an absolute fixtures folder (another checkout's, from a worktree); MENARD_FIELD_OUT: where outputs go, default beside each fixture. */
const ROOT = process.env.MENARD_FIELD_FIXTURES ?? join(import.meta.dirname, "../../fixtures-private");
const OUT = process.env.MENARD_FIELD_OUT;
const CLAUDE = process.env.MENARD_CLAUDE ?? `${process.env.HOME}/.local/bin/claude`;
const FIRST_WORDS = 4;

interface Expected {
	settings?: Partial<MenardSettings>;
	pairs: { source: string[]; target: string[] }[];
}

const fixtures = existsSync(ROOT)
	? readdirSync(ROOT).filter((name) => ["source.md", "translation.md", "expected.json"].every((file) => existsSync(join(ROOT, name, file))))
	: [];

const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const firstWords = (body: string): string => projectMarkdown(body).text.split(/\s+/).filter(Boolean).slice(0, FIRST_WORDS).join(" ");

/** The words of every text unit of a note, in order: what Align must never change. */
function unitWords(text: string, settings: MenardSettings, target: boolean): string[][] {
	const options = parseOptions(settings);
	const note = parseNote(text, target ? { textStartHeading: "", skipHeadings: options.skipHeadings } : options);
	return textUnits(note).map((block) => wordsOf(projectMarkdown(block.body).text).map((word) => word.norm));
}

function sides(model: PairModel): { source: string[]; target: string[]; keys: string; flagged: number; loose: number; links: number }[] {
	return model.units
		.filter((unit) => unit.kind !== "heading" && unit.source !== null && unit.target !== null)
		.map((unit) => {
			const links = unit.map?.links ?? [];
			return {
				source: unitBlocks(unit, "source").map((block) => firstWords(block.body)),
				target: unitBlocks(unit, "target").map((block) => firstWords(block.body)),
				keys: (unit.group?.keys ?? [unit.key]).join("+"),
				flagged: links.filter((link) => link.src === null || link.tgt === null).length,
				loose: links.filter((link) => link.loose).length,
				links: links.length,
			};
		});
}

const matches = (expected: readonly string[], actual: readonly string[]): boolean =>
	expected.length === actual.length && expected.every((words, i) => norm(actual[i] ?? "").startsWith(norm(words)) || norm(words).startsWith(norm(actual[i] ?? "")));

describe.skipIf(fixtures.length === 0)("field regression (real claude)", () => {
	for (const name of fixtures) {
		it(name, async () => {
			const dir = join(ROOT, name);
			const out = OUT === undefined ? dir : join(OUT, name);
			mkdirSync(out, { recursive: true });
			const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
			const sourceText = readFileSync(join(dir, "source.md"), "utf8");
			const targetText = readFileSync(join(dir, "translation.md"), "utf8");
			const h = createHarness({ concurrency: 3, ...expected.settings });
			const real = new ClaudeCliBackend(async () => CLAUDE);
			(h.deps as { backend: unknown }).backend = real;
			const source = h.vault.add(`Field/${name}.md`, sourceText);
			const target = h.vault.add(`Field/${name} (EN).md`, targetText);
			const started = Date.now();
			await runAlign(h.deps, source, target, new AbortController());
			const sourceAfter = h.vault.text(source);
			const targetAfter = h.vault.text(target);
			writeFileSync(join(out, "out-source.md"), sourceAfter);
			writeFileSync(join(out, "out-translation.md"), targetAfter);

			const settings = h.settings;
			const options = parseOptions(settings);
			const model = buildPairModel({
				sourcePath: source.path,
				targetPath: target.path,
				languages: { source: settings.defaultSourceLanguage, target: settings.defaultTargetLanguage },
				version: 1,
				source: parseNote(sourceAfter, options),
				target: parseNote(targetAfter, { textStartHeading: "", skipHeadings: options.skipHeadings }),
			});
			const actual = sides(model);
			const wordDrift =
				JSON.stringify(unitWords(sourceAfter, settings, false)) !== JSON.stringify(unitWords(sourceText, settings, false)) ||
				JSON.stringify(unitWords(targetAfter, settings, true)) !== JSON.stringify(unitWords(targetText, settings, true));
			// Align also adds the frontmatter links; the bodies must come back byte for byte.
			const body = (text: string): string => stripMenard(text).replace(/^---\n[\s\S]*?\n---\n/, "");
			const strippedSame = body(sourceAfter) === body(sourceText) && body(targetAfter) === body(targetText);
			const matched = expected.pairs.filter((pair) => actual.some((unit) => matches(pair.source, unit.source) && matches(pair.target, unit.target)));
			const missing = expected.pairs.filter((pair) => !matched.includes(pair));
			const extra = actual.filter((unit) => !expected.pairs.some((pair) => matches(pair.source, unit.source) && matches(pair.target, unit.target)));
			const show = (pair: { source: readonly string[]; target: readonly string[] }): string => `${pair.source.join(" + ")} ↔ ${pair.target.join(" + ")}`;
			const total = (key: "flagged" | "loose" | "links"): number => actual.reduce((sum, unit) => sum + unit[key], 0);
			const report = [
				`# ${name} (${Math.round((Date.now() - started) / 1000)} s)`,
				`pairing: ${matched.length} of ${expected.pairs.length} expected pairs; ${extra.length} unexpected`,
				...missing.map((pair) => `  missing: ${show(pair)}`),
				...extra.map((unit) => `  unexpected: ${unit.keys}: ${show(unit)}`),
				`links ${total("links")}, flagged ${total("flagged")}, loose ${total("loose")}, Menard line problems ${model.problems.length}`,
				`text drift: ${wordDrift ? "YES" : "none"}; stripped bodies byte-identical: ${strippedSame ? "yes" : "no"}`,
				`preview: ${JSON.stringify(h.ui.alignSummaries.at(-1) ?? null)}`,
				`notices: ${JSON.stringify([...h.ui.notices, ...h.ui.summaries.map((s) => s.text)])}`,
				"actual pairing:",
				...actual.map((unit) => `  ${unit.keys}: ${show(unit)} | links ${unit.links}, flagged ${unit.flagged}, loose ${unit.loose}`),
			].join("\n");
			writeFileSync(join(out, "last-run.txt"), `${report}\n`);
			process.stdout.write(`${report}\n`);
			expect(wordDrift).toBe(false);
			expect(missing.map(show)).toEqual([]);
		});
	}
});
