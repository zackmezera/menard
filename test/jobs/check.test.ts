import { describe, expect, it } from "vitest";
import { parseMenardLine, serializeMenardLine, sideOf } from "../../src/align/map";
import { buildPairModel } from "../../src/align/model";
import { reconcileSide } from "../../src/align/reconcile";
import { bagHash } from "../../src/align/signature";
import { wordsOf } from "../../src/align/words";
import { refreshLinks, reportPair, runCheck } from "../../src/jobs/check";
import type { StartJob } from "../../src/jobs/controller";
import { runTranslate } from "../../src/jobs/translate";
import { parseNote } from "../../src/text/blocks";
import { projectMarkdown } from "../../src/text/inline";
import type { MapLink, PairModel } from "../../src/types";
import { createHarness } from "./harness";
import type { Harness } from "./harness";
import { QUIJOTE_EN, QUIJOTE_ES, SOURCE_NOTE } from "./fixtures";

const OPTIONS = { textStartHeading: "", skipHeadings: [] };
const QUIJOTE_MAP = "%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%";

function model(source: string, target: string): PairModel {
	return buildPairModel({
		sourcePath: "s.md",
		targetPath: "t.md",
		languages: { source: "es", target: "en" },
		version: 1,
		source: parseNote(source, OPTIONS),
		target: parseNote(target, OPTIONS),
	});
}

function quijoteLinks(): readonly MapLink[] {
	const parsed = parseMenardLine(QUIJOTE_MAP);
	if ("error" in parsed || parsed.kind !== "map") throw new Error("bad map");
	return parsed.links;
}

describe("reportPair", () => {
	it("lists source paragraphs that never got an id as untranslated (#24)", () => {
		const source = `${QUIJOTE_ES}\n\nPablo Martín Ruiz, Cuadernos LIRICO 12 (2015).\n`;
		const parsed = parseNote(source, OPTIONS);
		const report = reportPair(model(source, `${QUIJOTE_EN}\n\n${QUIJOTE_MAP}\n`), parsed);
		expect(report.untranslated).toEqual([2]);
		expect(report.unpairedSource).toEqual([]);
	});

	it("is clean for an exact pair", () => {
		expect(reportPair(model(QUIJOTE_ES, `${QUIJOTE_EN}\n\n${QUIJOTE_MAP}\n`))).toEqual({
			unpairedSource: [], untranslated: [],
			unpairedTarget: [],
			pending: [],
			repaired: [],
			degraded: [],
			problems: [],
		});
	});

	it("sorts units into repaired, degraded, pending, unpaired and problems", () => {
		const source = [QUIJOTE_ES, "Segundo párrafo, aún sin traducir. ^p2", "Tercero. Con dos frases. ^p3", "Cuarto párrafo. ^p4"].join("\n\n");
		const typo = QUIJOTE_EN.replace("a lean hack", "a lean hackney");
		const target = [
			typo.replace("lance-rack", "rack"),
			QUIJOTE_MAP,
			"%%menard:1 p2 translate%%",
			"Third. ^p3",
			"%%menard:1 p3 1.aaaa/1.bbbb 3.cccc/2.dddd%%",
			"Fourth paragraph, no map. ^p4",
			"A translator's preface. ^t1",
			"%%menard:1 p9 bogus%%",
			"",
		].join("\n\n");
		const report = reportPair(model(source, target));
		expect(report).toEqual({
			unpairedSource: [], untranslated: [],
			unpairedTarget: ["t1"],
			pending: ["p2"],
			repaired: ["p1"],
			degraded: ["p3", "p4"],
			problems: [14],
		});
	});
});

describe("refreshLinks", () => {
	it("rewrites the counts and hashes of an edited sentence, keeping the link structure", () => {
		const edited = QUIJOTE_EN.replace("a lean hack,", "a lean old hack,");
		const block = parseNote(edited, OPTIONS).blocks[0];
		const sourceBlock = parseNote(QUIJOTE_ES, OPTIONS).blocks[0];
		if (block === undefined || sourceBlock === undefined) throw new Error("no block");
		const links = refreshLinks(quijoteLinks(), sourceBlock.body, block.body);
		expect(serializeMenardLine({ kind: "map", key: "p1", links })).toMatch(/^%%menard:1 p1 33\.myfp\/47\.\w{4} 33\.7teg\/35\.ny2r%%$/);
		const text = projectMarkdown(block.body).text;
		expect(reconcileSide(sideOf(links, "tgt"), wordsOf(text), text).status).toBe("exact");
	});

	it("keeps loose flags and null sides", () => {
		const links: MapLink[] = [
			{ src: { count: 2, hash: "zzzz" }, tgt: { count: 2, hash: bagHash(["hello", "world"]) }, loose: true },
			{ src: null, tgt: { count: 1, hash: bagHash(["added"]) }, loose: false },
		];
		const refreshed = refreshLinks(links, "Hola, mundo.", "Hello world. Added.");
		expect(refreshed).toEqual([
			{ src: { count: 2, hash: bagHash(["hola", "mundo"]) }, tgt: links[0]?.tgt, loose: true },
			{ src: null, tgt: links[1]?.tgt, loose: false },
		]);
	});

	it("refuses a map that no longer fits", () => {
		expect(() => refreshLinks(quijoteLinks(), QUIJOTE_ES, "Nothing like the original at all.")).toThrow("needs realigning");
	});
});

describe("runCheck", () => {
	async function translatedPair(): Promise<Harness> {
		const h = createHarness();
		const source = h.vault.add("T/@x.md", SOURCE_NOTE);
		await runTranslate(h.deps, source, new AbortController());
		return h;
	}
	const start =
		(log: string[]): StartJob =>
		async (work) => {
			log.push("start");
			await work(new AbortController());
		};

	it("shows the report and refreshes repaired maps without Claude", async () => {
		const h = await translatedPair();
		const target = h.vault.getFileByPath("T/@x (EN).md");
		if (target === null) throw new Error("no translation");
		h.vault.edit(target, h.vault.text(target).replace("EN Esa lectura, dice,", "EN Esa lectura, dice ella,"));
		const log: string[] = [];
		await runCheck(h.deps, target, start(log));
		const shown = h.ui.reports[0];
		expect(shown?.report.repaired).toEqual(["p1"]);
		const calls = h.backend.requests.length;
		shown?.actions.refresh?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(log).toEqual(["start"]);
		expect(h.backend.requests).toHaveLength(calls);
		expect(h.ui.notices.at(-1)).toBe("Refreshed 1 sentence map.");
		await runCheck(h.deps, target, start(log));
		expect(h.ui.reports[1]?.report.repaired).toEqual([]);
	});

	it("offers to repair a one-sided pair link", async () => {
		const h = createHarness();
		const source = h.vault.add("T/@x.md", '---\ntranslation: "[[@x (EN)]]"\n---\nTexto.\n');
		const target = h.vault.add("T/@x (EN).md", "Text.\n");
		await runCheck(h.deps, source, start([]));
		h.ui.reports[0]?.actions.repairLink?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(h.vault.text(target)).toContain('source: "[[@x]]"');
		expect(h.deps.pairs.resolve(source)?.side).toBe("source");
	});

	it("says when a note is not in a pair", async () => {
		const h = createHarness();
		await runCheck(h.deps, h.vault.add("T/solo.md", "Texto.\n"), start([]));
		expect(h.ui.notices).toEqual(["This note is not part of a pair."]);
	});
});
