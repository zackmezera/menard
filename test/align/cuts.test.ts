import { describe, expect, it } from "vitest";
import { linkCharRanges } from "../../src/align/cuts";
import { wordsOf } from "../../src/align/words";
import type { CharRange, WordRange } from "../../src/types";

/** The text of each link, cutting after the given word counts. */
function pieces(text: string, counts: readonly number[]): string[] {
	return slices(text, rangesFor(counts));
}

function rangesFor(counts: readonly number[]): WordRange[] {
	let at = 0;
	return counts.map((count) => ({ start: at, end: (at += count) }));
}

function slices(text: string, ranges: readonly WordRange[]): string[] {
	return linkCharRanges(text, wordsOf(text), ranges).map((r) => text.slice(r.start, r.end));
}

function expectContiguous(text: string, ranges: readonly CharRange[]): void {
	expect(ranges[0]?.start).toBe(0);
	expect(ranges.at(-1)?.end).toBe(text.length);
	ranges.slice(1).forEach((r, i) => expect(r.start).toBe(ranges[i]?.end));
}

describe("linkCharRanges", () => {
	it("sends opening «¿ with the sentence they open", () => {
		const text = "Borges lo dice sin rodeos. «¿Quién escribe a quién?», pregunta el narrador.";
		expect(pieces(text, [5, 7])).toEqual(["Borges lo dice sin rodeos. ", "«¿Quién escribe a quién?», pregunta el narrador."]);
	});

	it("keeps closing ». with the sentence they close", () => {
		const text = "Ruiz la llama «una ficción crítica». Luego matiza: “no del todo”. Y concluye.";
		expect(pieces(text, [6, 5, 2])).toEqual(["Ruiz la llama «una ficción crítica». ", "Luego matiza: “no del todo”. ", "Y concluye."]);
	});

	it("keeps a period whose footnote ref was projected away with its sentence", () => {
		// Markdown: "…galgo corredor.[^1] Una olla…"; the projection drops the ref.
		const text = "rocín flaco y galgo corredor. Una olla de algo más vaca que carnero";
		expect(pieces(text, [5, 8])).toEqual(["rocín flaco y galgo corredor. ", "Una olla de algo más vaca que carnero"]);
	});

	it("keeps a closing parenthesis and its citation with the sentence", () => {
		const text = "Fue decisiva (Ruiz 2002, p. 14). (Véase también la nota 3.)";
		expect(pieces(text, [6, 5])).toEqual(["Fue decisiva (Ruiz 2002, p. 14). ", "(Véase también la nota 3.)"]);
	});

	it("cuts at the word's start when a token joins two links without a space", () => {
		expect(pieces("Termina aquí.Empieza otra", [2, 2])).toEqual(["Termina aquí.", "Empieza otra"]);
		expect(pieces("Termina aquí.«Empieza» otra", [2, 2])).toEqual(["Termina aquí.«", "Empieza» otra"]);
	});

	it("splits inside a hyphenated token at the word", () => {
		expect(pieces("el período 1919-1929 entero", [3, 2])).toEqual(["el período 1919-", "1929 entero"]);
	});

	it("starts the first link at 0 and ends the last at text.length, including outer whitespace", () => {
		const text = "  «Dijo algo.» \n";
		const ranges = linkCharRanges(text, wordsOf(text), [{ start: 0, end: 2 }]);
		expect(ranges).toEqual([{ start: 0, end: text.length }]);
	});

	it("places empty links at the cut and stays contiguous", () => {
		const text = "Una frase. Otra frase. Tercera.";
		const ranges = linkCharRanges(text, wordsOf(text), [
			{ start: 0, end: 0 },
			{ start: 0, end: 2 },
			{ start: 2, end: 2 },
			{ start: 2, end: 4 },
			{ start: 4, end: 5 },
			{ start: 5, end: 5 },
		]);
		expect(ranges).toEqual([
			{ start: 0, end: 0 },
			{ start: 0, end: 11 },
			{ start: 11, end: 11 },
			{ start: 11, end: 23 },
			{ start: 23, end: 31 },
			{ start: 31, end: 31 },
		]);
		expectContiguous(text, ranges);
	});

	it("handles a text with words not covered by any link", () => {
		const text = "Uno dos. Tres cuatro.";
		expect(slices(text, [{ start: 1, end: 2 }, { start: 3, end: 4 }])).toEqual(["Uno dos. Tres ", "cuatro."]);
	});
});
