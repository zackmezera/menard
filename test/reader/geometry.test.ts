import { describe, expect, it } from "vitest";
import {
	clampScrollTop,
	followerScrollTop,
	fractionThrough,
	inComfortBand,
	inViewport,
	isShortMove,
	readingLine,
	scrollTopToPlace,
} from "../../src/reader/geometry";
import type { ScrollerBox } from "../../src/reader/geometry";

const box: ScrollerBox = { scrollTop: 500, top: 100, height: 1000, scrollHeight: 5000 };

describe("geometry", () => {
	it("puts the reading line at 35% of the viewport", () => {
		expect(readingLine(box)).toBe(450);
	});

	it("bounds the comfort band at 22% and 62%", () => {
		expect(inComfortBand(box, 319)).toBe(false);
		expect(inComfortBand(box, 320)).toBe(true);
		expect(inComfortBand(box, 720)).toBe(true);
		expect(inComfortBand(box, 721)).toBe(false);
	});

	it("knows the viewport", () => {
		expect(inViewport(box, 99)).toBe(false);
		expect(inViewport(box, 100)).toBe(true);
		expect(inViewport(box, 1100)).toBe(true);
		expect(inViewport(box, 1101)).toBe(false);
	});

	it("places an element at a target y", () => {
		expect(scrollTopToPlace(box, 900, 450)).toBe(950);
		expect(scrollTopToPlace(box, 300, 450)).toBe(350);
	});

	it("clamps to [0, scrollHeight - height]", () => {
		expect(clampScrollTop(box, -20)).toBe(0);
		expect(clampScrollTop(box, 4500)).toBe(4000);
		expect(scrollTopToPlace(box, -2000, 450)).toBe(0);
		expect(scrollTopToPlace(box, 9000, 450)).toBe(4000);
		expect(clampScrollTop({ ...box, scrollHeight: 400 }, 50)).toBe(0);
	});

	it("places the follower's matching point at its reading line", () => {
		// Partner from 600 to 1000; 25% through is 700; reading line 450.
		expect(followerScrollTop(box, 600, 400, 0.25)).toBe(750);
		expect(followerScrollTop(box, 600, 400, 0)).toBe(650);
		expect(followerScrollTop(box, 600, 400, 2)).toBe(followerScrollTop(box, 600, 400, 1));
		expect(followerScrollTop({ ...box, scrollTop: 0 }, -4000, 100, 0)).toBe(0);
	});

	it("measures fractions through a span", () => {
		expect(fractionThrough(100, 200, 150)).toBe(0.25);
		expect(fractionThrough(100, 200, 50)).toBe(0);
		expect(fractionThrough(100, 200, 900)).toBe(1);
		expect(fractionThrough(100, 0, 100)).toBe(0);
	});

	it("animates only moves within 1.5 viewports", () => {
		expect(isShortMove(box, 2000)).toBe(true);
		expect(isShortMove(box, 2001)).toBe(false);
		expect(isShortMove(box, 0)).toBe(true);
	});
});
