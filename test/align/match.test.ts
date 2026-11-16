import { describe, expect, it } from "vitest";
import { matchItem, matchUnits, type MatchItem } from "../../src/align/match";
import { block } from "./helpers";

function item(kind: MatchItem["kind"], words: number, section = 0, anchors: readonly string[] = []): MatchItem {
	return { kind, section, words, anchors };
}

/** Target items: same kinds, about 20% longer, as English runs against Spanish. */
function translated(items: readonly MatchItem[]): MatchItem[] {
	return items.map((i) => ({ ...i, words: Math.round(i.words * 1.2) }));
}

const SECTION = [item("paragraph", 40), item("paragraph", 25), item("quote", 18), item("paragraph", 60), item("list", 12), item("paragraph", 45)];

describe("matchItem", () => {
	it("collects digit runs, footnote keys and capitalized words of more than three letters", () => {
		const es = block({ kind: "paragraph", line: 0, raw: "Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.[^gen-1]" });
		const en = block({ kind: "paragraph", line: 0, raw: "According to Mr. Pérez (cf. pp. 23-25), J. L. Borges read Poe in Geneva around 1916.[^1]" });
		const esItem = matchItem(es, "Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra hacia 1916.", 2);
		const enItem = matchItem(en, "According to Mr. Pérez (cf. pp. 23-25), J. L. Borges read Poe in Geneva around 1916.", 2);
		expect(esItem).toEqual({
			kind: "paragraph",
			section: 2,
			words: 18,
			anchors: ["1916", "23", "25", "borges", "fn:1", "ginebra", "perez", "segun"],
		});
		expect(enItem.anchors).toEqual(["1916", "23", "25", "according", "borges", "fn:1", "geneva", "perez"]);
	});

	it("keys a footnote by its normalized label", () => {
		const fn = block({ kind: "footnote", line: 0, raw: "[^gen-3]: Cf. Balderston 1993.", footnoteLabel: "gen-3" });
		expect(matchItem(fn, "Cf. Balderston 1993.", 4).footnote).toBe("fn:3");
		const para = block({ kind: "paragraph", line: 0, raw: "Texto." });
		expect(matchItem(para, "Texto.", 4)).not.toHaveProperty("footnote");
	});

	it("ignores lower-case and short capitalized words", () => {
		const b = block({ kind: "quote", line: 0, raw: "> el deseo del Uno y de Poe" });
		expect(matchItem(b, "el deseo del Uno y de Poe", -1).anchors).toEqual([]);
	});
});

describe("matchUnits", () => {
	it("returns the diagonal for identical kind sequences", () => {
		const result = matchUnits(SECTION, translated(SECTION));
		expect(result.pairs).toEqual(SECTION.map((_, i) => ({ source: [i], target: [i], doubtful: false })));
		expect(result.sourceOnly).toEqual([]);
		expect(result.targetOnly).toEqual([]);
	});

	it("skips a translation-only provenance callout", () => {
		const target = [item("callout", 22), ...translated(SECTION)];
		const result = matchUnits(SECTION, target);
		expect(result.targetOnly).toEqual([0]);
		expect(result.sourceOnly).toEqual([]);
		expect(result.pairs).toEqual(SECTION.map((_, i) => ({ source: [i], target: [i + 1], doubtful: false })));
	});

	it("skips a source paragraph the translation left out", () => {
		const target = translated(SECTION).filter((_, i) => i !== 3);
		const result = matchUnits(SECTION, target);
		expect(result.sourceOnly).toEqual([3]);
		expect(result.pairs.map((p) => [...p.source, ...p.target])).toEqual([[0, 0], [1, 1], [2, 2], [4, 3], [5, 4]]);
	});

	it("flags a 1-1 pair whose length ratio is far from the section's", () => {
		const target = translated(SECTION);
		target[1] = item("paragraph", 160);
		const result = matchUnits(SECTION, target);
		expect(result.pairs.map((p) => p.doubtful)).toEqual([false, true, false, false, false, false]);

		const withCallout = matchUnits(SECTION, [item("callout", 22), ...target]);
		expect(withCallout.pairs.find((p) => p.source[0] === 1)).toEqual({ source: [1], target: [2], doubtful: true });
	});

	it("never pairs a quote with a paragraph", () => {
		const result = matchUnits([item("quote", 20)], [item("paragraph", 22)]);
		expect(result).toEqual({ pairs: [], sourceOnly: [0], targetOnly: [0] });
	});

	it("pairs other kind mismatches when the alternative is worse", () => {
		const result = matchUnits([item("paragraph", 30), item("callout", 40)], [item("paragraph", 35), item("quote", 48)]);
		expect(result.pairs.map((p) => [...p.source, ...p.target, p.doubtful])).toEqual([
			[0, 0, false],
			[1, 1, true],
		]);
	});

	it("uses shared anchors to choose between similar units", () => {
		const source = [item("paragraph", 20, 0, ["1916", "ginebra"]), item("paragraph", 20, 0, ["borges", "fn:3"])];
		const target = [item("paragraph", 24, 0, ["borges", "fn:3"])];
		expect(matchUnits(source, target)).toEqual({ pairs: [{ source: [1], target: [0], doubtful: false }], sourceOnly: [0], targetOnly: [] });
	});

	it("pairs sections by index and leaves units of unmatched sections one-sided", () => {
		const source = [item("paragraph", 10, -1), item("paragraph", 30, 0), item("paragraph", 30, 0), item("paragraph", 50, 1)];
		const target = [item("paragraph", 12, -1), item("paragraph", 36, 0), item("callout", 15, 0), item("paragraph", 36, 0), item("paragraph", 20, 2)];
		const result = matchUnits(source, target);
		expect(result.pairs.map((p) => [...p.source, ...p.target])).toEqual([[0, 0], [1, 1], [2, 3]]);
		expect(result.sourceOnly).toEqual([3]);
		expect(result.targetOnly).toEqual([2, 4]);
	});

	it("pairs footnotes by key, not by position, and keeps them out of the section pass", () => {
		const fn = (key: string | undefined, words: number): MatchItem => ({ ...item("footnote", words, 2), ...(key === undefined ? {} : { footnote: key }) });
		const source = [item("paragraph", 30, 2), fn("fn:1", 10), fn("fn:2", 12), fn("fn:3", 8), fn(undefined, 5)];
		// The translation lacks fn:2, adds fn:9, repeats fn:1 and orders its definitions differently.
		const target = [fn("fn:3", 9), item("paragraph", 36, 2), fn("fn:9", 4), fn("fn:1", 11), fn("fn:1", 3)];
		const result = matchUnits(source, target);
		expect(result.pairs).toEqual([
			{ source: [0], target: [1], doubtful: false },
			{ source: [1], target: [3], doubtful: false },
			{ source: [3], target: [0], doubtful: false },
		]);
		expect(result.sourceOnly).toEqual([2, 4]);
		expect(result.targetOnly).toEqual([2, 4]);
	});

	it("handles empty inputs", () => {
		expect(matchUnits([], [])).toEqual({ pairs: [], sourceOnly: [], targetOnly: [] });
		expect(matchUnits([item("paragraph", 3)], [])).toEqual({ pairs: [], sourceOnly: [0], targetOnly: [] });
	});
});
