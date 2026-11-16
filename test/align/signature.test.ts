import { describe, expect, it } from "vitest";
import { bagHash, fnv1a32, sideSig } from "../../src/align/signature";
import { normalizeWord, wordsOf } from "../../src/align/words";
import { sigText } from "./helpers";
import { LACAN, LACAN_REWRITTEN, LACAN_TYPO, ORMSBY_1, ORMSBY_2, ORMSBY_2_SPLIT, ORMSBY_ADDITION, QUIJOTE_1, QUIJOTE_2 } from "./fixtures";

describe("wordsOf", () => {
	it("finds maximal letter, digit and mark runs with offsets into the given string", () => {
		const text = "«¿Quién leyó a Borges's Poe en 1919-1929?»";
		const words = wordsOf(text);
		expect(words.map((w) => text.slice(w.start, w.end))).toEqual(["Quién", "leyó", "a", "Borges", "s", "Poe", "en", "1919", "1929"]);
		expect(words[0]).toEqual({ start: 2, end: 7, norm: "quien" });
	});

	it("ignores punctuation, emphasis markers and brackets", () => {
		expect(wordsOf("*cf.* [[Lacan, Jacques]] — (p. 14)…").map((w) => w.norm)).toEqual(["cf", "lacan", "jacques", "p", "14"]);
	});

	it("keeps combining marks inside a word", () => {
		const decomposed = "acción";
		expect(wordsOf(decomposed)).toEqual([{ start: 0, end: 7, norm: "accion" }]);
	});

	it("returns nothing for text without words", () => {
		expect(wordsOf(" — «»… ")).toEqual([]);
	});
});

describe("normalizeWord", () => {
	it("decomposes compatibility forms, strips marks and lower-cases", () => {
		expect(normalizeWord("Almotásim")).toBe("almotasim");
		expect(normalizeWord("ÑANDÚ")).toBe("nandu");
		expect(normalizeWord("ﬁn")).toBe("fin");
	});
});

describe("fnv1a32", () => {
	it("matches the published FNV-1a vectors", () => {
		expect(fnv1a32("")).toBe(0x811c9dc5);
		expect(fnv1a32("a")).toBe(0xe40c292c);
		expect(fnv1a32("foobar")).toBe(0xbf9cf968);
	});
});

describe("bagHash", () => {
	it("is order-insensitive and always four base-36 characters", () => {
		expect(bagHash(["deseo", "otro"])).toBe(bagHash(["otro", "deseo"]));
		expect(bagHash([])).toMatch(/^[0-9a-z]{4}$/);
	});
});

describe("known-answer vectors (DESIGN §4.3)", () => {
	it.each([
		["Quijote sentence 1", QUIJOTE_1, "33.myfp"],
		["Quijote sentence 2", QUIJOTE_2, "33.7teg"],
		["Ormsby sentence 1", ORMSBY_1, "46.6ton"],
		["Ormsby sentence 2", ORMSBY_2, "35.ny2r"],
		["Quijote sentences 1 and 2 fused", `${QUIJOTE_1} ${QUIJOTE_2}`, "66.j87o"],
		["Ormsby sentence 2 rendered as two", ORMSBY_2_SPLIT, "36.xsyq"],
		["a translator's addition", ORMSBY_ADDITION, "7.e5eo"],
		["Lacan", LACAN, "11.grrx"],
		["Lacan after the nightly rewrite", LACAN_REWRITTEN, "11.grrx"],
		["Lacan with a typo", LACAN_TYPO, "11.k379"],
	])("%s", (_name, sentence, expected) => {
		expect(sigText(sentence)).toBe(expected);
	});
});

describe("sideSig", () => {
	it("signs a sub-range of words", () => {
		const words = wordsOf(`${QUIJOTE_1} ${QUIJOTE_2}`);
		expect(sideSig(words, { start: 33, end: 66 })).toEqual({ count: 33, hash: "7teg" });
	});

	it("rejects empty and out-of-bounds ranges", () => {
		const words = wordsOf(LACAN);
		expect(() => sideSig(words, { start: 3, end: 3 })).toThrow(RangeError);
		expect(() => sideSig(words, { start: 0, end: 12 })).toThrow(RangeError);
	});
});
