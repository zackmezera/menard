// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSITIONS_LIMIT, ReadingPositions } from "../../src/reader/positions";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ReadingPositions", () => {
	it("remembers the last stop per source note and saves once after a burst of moves", () => {
		const save = vi.fn();
		const positions = new ReadingPositions(save, 3, 100);
		positions.set("a.md", { unit: "p1", link: 1 });
		positions.set("a.md", { unit: "p1", link: 2 });
		positions.set("a.md", { unit: "p2", link: null });
		expect(save).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(save).toHaveBeenCalledTimes(1);
		expect(positions.get("a.md")).toEqual({ unit: "p2", link: null });
		expect(positions.get("b.md")).toBeNull();
	});

	it("drops the least recently read note beyond the limit", () => {
		const positions = new ReadingPositions(() => {}, 3, 100);
		for (const path of ["a.md", "b.md", "c.md"]) positions.set(path, { unit: "p1", link: 1 });
		positions.set("a.md", { unit: "p2", link: 1 });
		positions.set("d.md", { unit: "p1", link: 1 });
		expect(Object.keys(positions.toJSON())).toEqual(["c.md", "a.md", "d.md"]);
		expect(positions.get("b.md")).toBeNull();
	});

	it("defaults to 200 notes", () => {
		const positions = new ReadingPositions(() => {});
		for (let i = 0; i <= POSITIONS_LIMIT; i++) positions.set(`${i}.md`, { unit: "p1", link: null });
		expect(POSITIONS_LIMIT).toBe(200);
		expect(Object.keys(positions.toJSON())).toHaveLength(200);
		expect(positions.get("0.md")).toBeNull();
	});

	it("loads stored data, skipping malformed entries, and round-trips through JSON", () => {
		const positions = new ReadingPositions(() => {});
		positions.load({
			"a.md": { unit: "p3", link: 2 },
			"b.md": { unit: "p4", link: null },
			"c.md": { unit: "", link: 1 },
			"d.md": { unit: "p1", link: 0 },
			"e.md": "p1.2",
			"f.md": { unit: "p1", link: 1.5 },
		});
		expect(positions.toJSON()).toEqual({ "a.md": { unit: "p3", link: 2 }, "b.md": { unit: "p4", link: null } });
		const again = new ReadingPositions(() => {});
		again.load(JSON.parse(JSON.stringify(positions)));
		expect(again.get("a.md")).toEqual({ unit: "p3", link: 2 });
		for (const stored of [undefined, null, [], "x"]) {
			again.load(stored);
			expect(again.toJSON()).toEqual({});
		}
	});

	it("writes a pending change on flush, and nothing when none is pending", () => {
		const save = vi.fn();
		const positions = new ReadingPositions(save, 3, 100);
		positions.flush();
		expect(save).not.toHaveBeenCalled();
		positions.set("a.md", { unit: "p1", link: 1 });
		positions.flush();
		expect(save).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("does not save again for the same stop on the most recent note", () => {
		const save = vi.fn();
		const positions = new ReadingPositions(save, 3, 100);
		positions.set("a.md", { unit: "p1", link: 1 });
		vi.advanceTimersByTime(100);
		positions.set("a.md", { unit: "p1", link: 1 });
		vi.advanceTimersByTime(100);
		expect(save).toHaveBeenCalledTimes(1);
	});
});
