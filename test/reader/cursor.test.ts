import { describe, expect, it } from "vitest";
import { parseLinkAttr, resolveStop, sameStop, stepStop, stopAttr } from "../../src/reader/cursor";
import type { CursorStop } from "../../src/types";

const s = (unit: string, link: number | null): CursorStop => ({ unit, link });
// p1 has three links, p2 is a whole-unit stop (a list), p3 two links, fn:en-1 is never a stop.
const STOPS = [s("p1", 1), s("p1", 2), s("p1", 3), s("p2", null), s("p3", 1), s("p3", 2)];

describe("stepStop by link", () => {
	it.each([
		[s("p1", 1), 1, s("p1", 2)],
		[s("p1", 3), 1, s("p2", null)],
		[s("p2", null), 1, s("p3", 1)],
		[s("p3", 1), -1, s("p2", null)],
		[s("p1", 2), -1, s("p1", 1)],
	] as const)("from %o by %i", (from, delta, expected) => {
		expect(stepStop(STOPS, from, "link", delta)).toEqual(expected);
	});

	it("returns null past either end", () => {
		expect(stepStop(STOPS, s("p3", 2), "link", 1)).toBeNull();
		expect(stepStop(STOPS, s("p1", 1), "link", -1)).toBeNull();
	});

	it("starts at the first or last stop from nowhere", () => {
		expect(stepStop(STOPS, null, "link", 1)).toEqual(s("p1", 1));
		expect(stepStop(STOPS, null, "link", -1)).toEqual(s("p3", 2));
	});

	it("returns null when there are no stops", () => {
		expect(stepStop([], null, "link", 1)).toBeNull();
		expect(stepStop([], s("p1", 1), "unit", -1)).toBeNull();
	});
});

describe("stepStop by unit", () => {
	it("goes to the first stop of the next unit", () => {
		expect(stepStop(STOPS, s("p1", 2), "unit", 1)).toEqual(s("p2", null));
		expect(stepStop(STOPS, s("p2", null), "unit", 1)).toEqual(s("p3", 1));
	});

	it("goes to the first stop of the previous unit, from anywhere in a unit", () => {
		expect(stepStop(STOPS, s("p3", 2), "unit", -1)).toEqual(s("p2", null));
		expect(stepStop(STOPS, s("p3", 1), "unit", -1)).toEqual(s("p2", null));
		expect(stepStop(STOPS, s("p2", null), "unit", -1)).toEqual(s("p1", 1));
	});

	it("returns null at the first and last unit", () => {
		expect(stepStop(STOPS, s("p3", 1), "unit", 1)).toBeNull();
		expect(stepStop(STOPS, s("p1", 3), "unit", -1)).toBeNull();
	});

	it("starts at the first stop of the first or last unit from nowhere", () => {
		expect(stepStop(STOPS, null, "unit", 1)).toEqual(s("p1", 1));
		expect(stepStop(STOPS, null, "unit", -1)).toEqual(s("p3", 1));
	});
});

describe("stepStop from a stale cursor", () => {
	it("steps from the nearest earlier link of the same unit after a rebuild shortened it", () => {
		expect(stepStop(STOPS, s("p1", 7), "link", 1)).toEqual(s("p2", null));
		expect(stepStop(STOPS, s("p3", 9), "link", -1)).toEqual(s("p3", 1));
	});

	it("starts over when the unit is gone", () => {
		expect(stepStop(STOPS, s("p99", 1), "link", 1)).toEqual(s("p1", 1));
	});
});

describe("resolveStop", () => {
	it("finds exact stops and maps a whole-unit reference to the unit's first stop", () => {
		expect(resolveStop(STOPS, s("p1", 2))).toEqual(s("p1", 2));
		expect(resolveStop(STOPS, s("p3", null))).toEqual(s("p3", 1));
		expect(resolveStop(STOPS, s("p2", null))).toEqual(s("p2", null));
	});

	it("rejects links that are not stops, such as a flagged translation-only link", () => {
		expect(resolveStop(STOPS, s("p1", 4))).toBeNull();
		expect(resolveStop(STOPS, s("fn:en-1", null))).toBeNull();
	});
});

describe("stop attributes", () => {
	it("formats link and unit stops", () => {
		expect(stopAttr(s("p12", 3))).toBe("p12.3");
		expect(stopAttr(s("p12", null))).toBe("p12");
		expect(stopAttr(s("intro-1", 1))).toBe("intro-1.1");
	});

	it("parses link attributes, including footnote keys", () => {
		expect(parseLinkAttr("p12.3")).toEqual(s("p12", 3));
		expect(parseLinkAttr("fn:en-3.1")).toEqual(s("fn:en-3", 1));
		for (const bad of ["p12", "p12.", ".3", "p12.0", "p12.x", "p12.03"]) expect(parseLinkAttr(bad)).toBeNull();
	});

	it("round-trips", () => {
		for (const stop of STOPS.filter((x) => x.link !== null)) expect(parseLinkAttr(stopAttr(stop))).toEqual(stop);
	});

	it("compares stops", () => {
		expect(sameStop(null, null)).toBe(true);
		expect(sameStop(s("p1", 1), null)).toBe(false);
		expect(sameStop(s("p1", 1), s("p1", 1))).toBe(true);
		expect(sameStop(s("p1", 1), s("p1", null))).toBe(false);
	});
});
