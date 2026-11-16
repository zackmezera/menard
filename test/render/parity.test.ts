// @vitest-environment happy-dom
import { section } from "./dom-env";
import { describe, expect, it } from "vitest";
import { wordsOf } from "../../src/align/words";
import { projectElement } from "../../src/render/dom-projection";
import { projectMarkdown } from "../../src/text/inline";
import { PARITY_CASES } from "./fixtures";

/** DESIGN.md §5.2: both projections of a unit must yield the same words. */
describe("projection parity", () => {
	it.each(PARITY_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const unitEl = section(c.html).firstElementChild as HTMLElement;
		const dom = wordsOf(projectElement(unitEl).text).map((w) => w.norm);
		const markdown = wordsOf(projectMarkdown(c.markdown).text).map((w) => w.norm);
		expect(dom.length).toBeGreaterThan(0);
		expect(dom).toEqual(markdown);
	});
});
