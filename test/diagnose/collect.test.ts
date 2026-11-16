// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { rendererSections } from "../../src/diagnose/collect";

describe("rendererSections", () => {
	it("reads Obsidian's private section list defensively", () => {
		const unit = document.createElement("div");
		const p = unit.appendChild(document.createElement("p"));
		p.setAttribute("data-menard-unit", "p4");
		p.textContent = "Some text";
		const line = document.createElement("div");
		line.setAttribute("data-menard-line", "");
		const sections = rendererSections({
			renderer: {
				sections: [
					{ lineStart: 3, lineEnd: 4, height: 42.5, rendered: true, el: unit },
					{ lineStart: 6, lineEnd: 6, height: -9, rendered: false, el: line },
					{ lineStart: "x", el: null },
				],
			},
		});
		expect(sections).toEqual([
			{ lineStart: 3, lineEnd: 4, height: 42.5, rendered: true, menardLine: false, unit: "p4", text: "Some text" },
			{ lineStart: 6, lineEnd: 6, height: -9, rendered: false, menardLine: true, unit: null, text: "" },
			{ lineStart: -1, lineEnd: -1, height: null, rendered: false, menardLine: false, unit: null, text: "" },
		]);
		expect(rendererSections({})).toBeNull();
	});
	it("falls back to start/end when lineStart/lineEnd are absent", () => {
		const sections = rendererSections({ renderer: { sections: [{ start: 4, end: 6, height: 20, rendered: true }, { height: 5 }] } });
		expect(sections?.map((s) => [s.lineStart, s.lineEnd])).toEqual([[4, 6], [-1, -1]]);
	});
});
