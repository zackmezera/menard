import { describe, expect, it } from "vitest";
import { reconcileSide } from "../../src/align/reconcile";
import { wordsOf } from "../../src/align/words";
import type { ReconciledSide, SideSig, WordRange } from "../../src/types";
import { seededRandom, sigOf } from "./helpers";
import { ACADEMIC, LACAN, LACAN_REWRITTEN, ORMSBY_1, ORMSBY_2, QUIJOTE_1, QUIJOTE_2 } from "./fixtures";

function reconcile(stored: readonly (SideSig | null)[], text: string): ReconciledSide {
	return reconcileSide(stored, wordsOf(text), text);
}

/** Word ranges of consecutive sentences joined by single spaces. */
function rangesOf(sentences: readonly string[]): WordRange[] {
	let start = 0;
	return sentences.map((s) => {
		const count = wordsOf(s).length;
		start += count;
		return { start: start - count, end: start };
	});
}

const ACADEMIC_SIGS = ACADEMIC.map(sigOf);

describe("reconcileSide", () => {
	it("fits unchanged text exactly", () => {
		const result = reconcile(ACADEMIC_SIGS, ACADEMIC.join(" "));
		expect(result).toEqual({ status: "exact", ranges: rangesOf(ACADEMIC), fits: ["exact", "exact", "exact", "exact"] });
	});

	it("fits the Quijote paragraph exactly, whatever the punctuation and quote style", () => {
		const text = `${QUIJOTE_1.replaceAll(",", ";")}\n${QUIJOTE_2.replace("Una olla", "«Una olla»")}`;
		expect(reconcile([sigOf(QUIJOTE_1), sigOf(QUIJOTE_2)], text).status).toBe("exact");
	});

	it("is unaffected by the nightly Lacan rewrite", () => {
		const stored = [sigOf(LACAN), sigOf(ACADEMIC[1] as string)];
		const result = reconcile(stored, `${LACAN_REWRITTEN} ${ACADEMIC[1]}`);
		expect(result.status).toBe("exact");
		expect(result.ranges).toEqual(rangesOf([LACAN, ACADEMIC[1] as string]));
	});

	it("localizes a word added in sentence 2 of 3 to link 2", () => {
		const sentences = ACADEMIC.slice(0, 3);
		const edited = [sentences[0], (sentences[1] as string).replace("fue", "fue, sin duda,"), sentences[2]] as string[];
		const result = reconcile(sentences.map(sigOf), edited.join(" "));
		expect(result.fits).toEqual(["exact", "edited", "exact"]);
		expect(result.status).toBe("repaired");
		expect(result.ranges).toEqual(rangesOf(edited));
	});

	it("localizes a word removed from the first sentence", () => {
		const edited = [(ACADEMIC[0] as string).replace(" hacia 1916", ""), ...ACADEMIC.slice(1)];
		const result = reconcile(ACADEMIC_SIGS, edited.join(" "));
		expect(result.fits).toEqual(["edited", "exact", "exact", "exact"]);
		expect(result.ranges).toEqual(rangesOf(edited));
	});

	it("approximates an edit spanning sentences 2 and 3 of 4, snapping the cut to the sentence end", () => {
		const edited = [
			ACADEMIC[0],
			(ACADEMIC[1] as string).replace("toda su obra", "toda su obra y su método"),
			(ACADEMIC[2] as string).replace("inexistente", "imaginaria"),
			ACADEMIC[3],
		] as string[];
		const words = wordsOf(edited.join(" "));
		const result = reconcileSide(ACADEMIC_SIGS, words, edited.join(" "));
		expect(result.fits).toEqual(["exact", "approximate", "approximate", "exact"]);
		expect(result.status).toBe("degraded");
		// The gap holds 17 + 14 words; the stored 14:14 ratio puts the ideal cut one word short of the period.
		const ranges = rangesOf(edited);
		const gapStart = (ranges[1] as WordRange).start;
		expect(gapStart + Math.round((31 * 14) / 28)).toBe((ranges[2] as WordRange).start - 1);
		expect(result.ranges).toEqual(rangesOf(edited));
	});

	it("keeps the proportional cut when no sentence end is within three words", () => {
		const s2 = "uno dos tres cuatro cinco seis siete ocho nueve diez.";
		const s3 = "once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte.";
		const run = "un dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte, todo junto";
		const text = `${ACADEMIC[0]} ${run}. ${ACADEMIC[3]}`;
		const result = reconcile([sigOf(ACADEMIC[0] as string), sigOf(s2), sigOf(s3), sigOf(ACADEMIC[3] as string)], text);
		expect(result.fits).toEqual(["exact", "approximate", "approximate", "exact"]);
		// 22 gap words split 10:10 cut after word 11 of the run.
		expect(result.ranges[1]).toEqual({ start: 18, end: 29 });
		expect(result.ranges[2]).toEqual({ start: 29, end: 40 });
	});

	it("does not snap a cut to the period inside a decimal number", () => {
		const s2 = "alfa beta gama delta épsilon.";
		const s3 = "zeta eta theta iota kappa.";
		const run = "uno dos tres 3.5 seis siete ocho nueve diez once";
		const text = `${ACADEMIC[0]} ${run}. ${ACADEMIC[3]}`;
		const result = reconcile([sigOf(ACADEMIC[0] as string), sigOf(s2), sigOf(s3), sigOf(ACADEMIC[3] as string)], text);
		const gapStart = (result.ranges[1] as WordRange).start;
		// 11 gap words split 5:5 put the cut at word 6; "3.5" two words earlier is not a sentence end.
		expect((result.ranges[1] as WordRange).end - gapStart).toBe(6);
	});

	it("gives every gap link at least one word when the gap has room for all", () => {
		const long = Array.from({ length: 40 }, (_, i) => `largo${i}`).join(" ");
		const stored = [sigOf(ACADEMIC[0] as string), sigOf("Uno."), sigOf("Dos."), sigOf(`${long}.`), sigOf(ACADEMIC[3] as string)];
		const result = reconcile(stored, `${ACADEMIC[0]} a b c d. ${ACADEMIC[3]}`);
		expect(result.fits).toEqual(["exact", "approximate", "approximate", "approximate", "exact"]);
		const gap = result.ranges.slice(1, 4).map((r) => r.end - r.start);
		expect(gap).toEqual([1, 1, 2]);
	});

	it("marks the surplus links lost when the gap has fewer words than links", () => {
		const stored = [sigOf(ACADEMIC[0] as string), sigOf("Uno dos."), sigOf("Tres cuatro."), sigOf("Cinco seis."), sigOf(ACADEMIC[3] as string)];
		const result = reconcile(stored, `${ACADEMIC[0]} siete ocho. ${ACADEMIC[3]}`);
		expect(result.status).toBe("degraded");
		expect(result.fits.filter((f) => f === "lost")).toHaveLength(1);
		expect(result.ranges.slice(1, 4).reduce((sum, r) => sum + r.end - r.start, 0)).toBe(2);
	});

	it("marks a deleted sentence lost and keeps its neighbours exact", () => {
		const edited = [ACADEMIC[0], ACADEMIC[2], ACADEMIC[3]] as string[];
		const result = reconcile(ACADEMIC_SIGS, edited.join(" "));
		expect(result.fits).toEqual(["exact", "lost", "exact", "exact"]);
		expect(result.status).toBe("degraded");
		const boundary = (rangesOf(edited)[1] as WordRange).start;
		expect(result.ranges[1]).toEqual({ start: boundary, end: boundary });
		expect(result.ranges[2]).toEqual(rangesOf(edited)[1]);
	});

	it("gives an added sentence to the link before it", () => {
		const edited = [ACADEMIC[0], ACADEMIC[1], "Nota del editor: véase el apéndice.", ACADEMIC[2], ACADEMIC[3]] as string[];
		const result = reconcile(ACADEMIC_SIGS, edited.join(" "));
		expect(result.fits).toEqual(["exact", "edited", "exact", "exact"]);
		const ranges = rangesOf(edited);
		expect(result.ranges[1]).toEqual({ start: (ranges[1] as WordRange).start, end: (ranges[2] as WordRange).end });
	});

	it("gives words added before the first link to that link", () => {
		const result = reconcile([sigOf(LACAN)], `Nótese: ${LACAN}`);
		expect(result).toEqual({ status: "repaired", ranges: [{ start: 0, end: 12 }], fits: ["edited"] });
	});

	it("degrades a total rewrite with every link lost", () => {
		const result = reconcile([sigOf(QUIJOTE_1), sigOf(QUIJOTE_2)], `${ORMSBY_1} ${ORMSBY_2}`);
		expect(result.status).toBe("degraded");
		expect(result.fits).toEqual(["lost", "lost"]);
		expect(result.ranges.every((r) => r.start === r.end)).toBe(true);
	});

	it("lets a single link absorb a total rewrite as an edit", () => {
		const result = reconcile([sigOf(QUIJOTE_1)], ORMSBY_1);
		expect(result).toEqual({ status: "repaired", ranges: [{ start: 0, end: 46 }], fits: ["edited"] });
	});

	it("gives null sides empty ranges in place", () => {
		const text = `${ORMSBY_1} ${ORMSBY_2}`;
		const result = reconcile([null, sigOf(ORMSBY_1), null, sigOf(ORMSBY_2), null], text);
		expect(result.status).toBe("exact");
		expect(result.fits).toEqual(["empty", "exact", "empty", "exact", "empty"]);
		expect(result.ranges).toEqual([
			{ start: 0, end: 0 },
			{ start: 0, end: 46 },
			{ start: 46, end: 46 },
			{ start: 46, end: 81 },
			{ start: 81, end: 81 },
		]);
	});

	it("handles a side with no stored links", () => {
		expect(reconcile([null], "")).toEqual({ status: "exact", ranges: [{ start: 0, end: 0 }], fits: ["empty"] });
		expect(reconcile([null], LACAN).status).toBe("degraded");
		expect(reconcile([], "").status).toBe("exact");
	});

	it("marks every link lost when the text is empty", () => {
		expect(reconcile([sigOf(LACAN), sigOf(QUIJOTE_1)], "")).toEqual({
			status: "degraded",
			ranges: [{ start: 0, end: 0 }, { start: 0, end: 0 }],
			fits: ["lost", "lost"],
		});
	});
});

describe("reconcileSide, randomized", () => {
	const random = seededRandom(0x5eed);
	const int = (max: number): number => Math.floor(random() * max);
	let fresh = 0;
	/** Unique made-up words, so no two sentences share a bag by accident. */
	const word = (): string => `pal${(fresh++).toString(36)}`;
	const sentence = (): string[] => Array.from({ length: 1 + int(12) }, word);

	it("never throws, stays in bounds and monotone, and never misplaces an exact link", () => {
		for (let trial = 0; trial < 500; trial++) {
			const original = Array.from({ length: 1 + int(6) }, sentence);
			const edited: { words: string[]; from: number | null }[] = original.map((words, from) => ({ words: [...words], from }));
			const touched = new Set<number>();
			for (let e = int(4); e > 0; e--) {
				const k = int(edited.length + 1);
				const target = edited[k];
				const op = int(5);
				if (op === 0 || target === undefined) {
					edited.splice(k, 0, { words: sentence(), from: null });
					continue;
				}
				if (op === 1) edited.splice(k, 1);
				else if (op === 2) target.words.splice(int(target.words.length + 1), 0, word());
				else if (op === 3 && target.words.length > 1) target.words.splice(int(target.words.length), 1);
				else target.words[int(target.words.length)] = word();
				if (target.from !== null) touched.add(target.from);
			}
			const nullAt = new Set(random() < 0.3 ? [int(original.length + 1)] : []);
			const stored: (SideSig | null)[] = [];
			const storedFrom: (number | null)[] = [];
			original.forEach((words, i) => {
				if (nullAt.has(i)) [stored[stored.length], storedFrom[storedFrom.length]] = [null, null];
				stored.push(sigOf(`${words.join(" ")}.`));
				storedFrom.push(i);
			});
			const text = edited.map((s) => `${s.words.join(" ")}.`).join(" ");
			const truth = new Map<number, WordRange>();
			let at = 0;
			for (const s of edited) {
				if (s.from !== null && !truth.has(s.from)) truth.set(s.from, { start: at, end: at + s.words.length });
				at += s.words.length;
			}

			const words = wordsOf(text);
			const result = reconcileSide(stored, words, text);
			expect(result.ranges).toHaveLength(stored.length);
			expect(result.fits).toHaveLength(stored.length);
			let previousEnd = 0;
			result.ranges.forEach((range, i) => {
				expect(range.start).toBeGreaterThanOrEqual(previousEnd);
				expect(range.end).toBeGreaterThanOrEqual(range.start);
				expect(range.end).toBeLessThanOrEqual(words.length);
				previousEnd = range.end;
				const from = storedFrom[i];
				if (result.fits[i] === "exact" && from != null) {
					// Exact means the range holds exactly the stored words, inside the sentence they came from.
					// (A word inserted at a sentence's start may still be credited to the link before it.)
					const home = truth.get(from) as WordRange;
					expect(range.start).toBeGreaterThanOrEqual(home.start);
					expect(range.end).toBeLessThanOrEqual(home.end);
					expect(words.slice(range.start, range.end).map((w) => w.norm)).toEqual(original[from]);
					if (!touched.has(from)) expect(range).toEqual(home);
				}
				if (stored[i] === null) expect(result.fits[i]).toBe("empty");
			});
			if (result.status === "exact") expect(previousEnd).toBe(words.length);
		}
	});
});
