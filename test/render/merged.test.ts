// @vitest-environment happy-dom
/**
 * Merged units (ADR 0010) in reading view: each paragraph of a merged side
 * carries the unit's key and its share of each link, so a link crossing
 * the paragraph boundary is one link in both; the gloss renders every
 * translation paragraph of a split.
 */
import { section } from "./dom-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, MarkdownRenderer } from "obsidian";
import { buildPairModel } from "../../src/align/model";
import { sideSig } from "../../src/align/signature";
import { wordsOf } from "../../src/align/words";
import { ATTR, CLS } from "../../src/constants";
import { OffscreenGloss } from "../../src/render/gloss";
import { StackedGloss } from "../../src/reader/stacked";
import { createPostProcessor } from "../../src/render/postprocessor";
import { parseNote } from "../../src/text/blocks";
import type { PairModel } from "../../src/types";
import { FakePairs, fakeApp, fakeContext, fakeSection, SOURCE_PATH, TARGET_PATH } from "./fakes";

const sig = (text: string): string => {
	const words = wordsOf(text);
	const s = sideSig(words, { start: 0, end: words.length });
	return `${s.count}.${s.hash}`;
};

// Source p1 and p2 are one translation paragraph; the second link crosses the source paragraph boundary.
// Source p3 is two translation paragraphs (p3 and p9).
const SOURCE = ["---", 'translation: "[[Quijote (EN)]]"', "---", "Seis siete ocho. ^p1", "", "Nueve diez. ^p2", "", "Trece catorce. Quince. ^p3", ""].join("\n");
const TARGET = [
	"---",
	'source: "[[Quijote]]"',
	"---",
	"Six seven eight nine ten. ^p1",
	"",
	`%%menard:1 p1+p2 ${sig("Seis siete")}/${sig("Six seven")} ${sig("ocho Nueve diez")}/${sig("eight nine ten")}%%`,
	"",
	"Thirteen fourteen. ^p3",
	"",
	"Fifteen. ^p9",
	"",
	`%%menard:1 p3+p9 ${sig("Trece catorce")}/${sig("Thirteen fourteen")} ${sig("Quince")}/${sig("Fifteen")}%%`,
	"",
].join("\n");

function model(): PairModel {
	const options = { textStartHeading: "", skipHeadings: [] };
	return buildPairModel({
		sourcePath: SOURCE_PATH,
		targetPath: TARGET_PATH,
		languages: { source: "es", target: "en" },
		version: 1,
		source: parseNote(SOURCE, options),
		target: parseNote(TARGET, options),
	});
}

function linkText(root: ParentNode, link: string): string {
	return Array.from(root.querySelectorAll(`span.${CLS.sentence}[${ATTR.link}="${link}"]`))
		.map((span) => span.textContent)
		.join("|");
}

afterEach(() => vi.restoreAllMocks());

describe("merged units in reading view", () => {
	it("tags both source paragraphs with the unit key and wraps each one's share", async () => {
		const m = model();
		expect(m.problems).toEqual([]);
		const fake = fakeApp({ [SOURCE_PATH]: SOURCE, [TARGET_PATH]: TARGET });
		const processor = createPostProcessor(fakeContext(fake.app), new FakePairs(m), { sectionRendered: vi.fn() });
		const first = section("<p>Seis siete ocho.</p>");
		const second = section("<p>Nueve diez.</p>");
		await processor(first, fakeSection({ sourcePath: SOURCE_PATH, text: SOURCE, lineStart: 3 }).ctx);
		await processor(second, fakeSection({ sourcePath: SOURCE_PATH, text: SOURCE, lineStart: 5 }).ctx);

		for (const el of [first, second]) {
			expect(el.querySelector("p")?.getAttribute(ATTR.unit)).toBe("p1");
			expect(el.querySelector("p")?.getAttribute(ATTR.fit)).toBe("exact");
		}
		expect(linkText(first, "p1.1")).toBe("Seis siete");
		expect(linkText(first, "p1.2")).toBe("ocho.");
		expect(linkText(second, "p1.1")).toBe("");
		expect(linkText(second, "p1.2")).toBe("Nueve diez.");

		const target = section("<p>Six seven eight nine ten.</p>");
		await processor(target, fakeSection({ sourcePath: TARGET_PATH, text: TARGET, lineStart: 3 }).ctx);
		expect(linkText(target, "p1.2")).toBe("eight nine ten.");
	});

	it("tags both translation paragraphs of a split", async () => {
		const fake = fakeApp({ [SOURCE_PATH]: SOURCE, [TARGET_PATH]: TARGET });
		const processor = createPostProcessor(fakeContext(fake.app), new FakePairs(model()), { sectionRendered: vi.fn() });
		const second = section("<p>Fifteen.</p>");
		await processor(second, fakeSection({ sourcePath: TARGET_PATH, text: TARGET, lineStart: 9 }).ctx);
		expect(second.querySelector("p")?.getAttribute(ATTR.unit)).toBe("p3");
		expect(linkText(second, "p3.2")).toBe("Fifteen.");
	});

	it("glosses a link from the second translation paragraph, and the whole split unit", async () => {
		const fake = fakeApp({ [SOURCE_PATH]: SOURCE, [TARGET_PATH]: TARGET });
		vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
			for (const paragraph of markdown.split("\n\n")) {
				const p = document.createElement("p");
				p.textContent = paragraph;
				el.appendChild(p);
			}
			return Promise.resolve();
		});
		const gloss = new OffscreenGloss(fake.app);
		const m = model();
		const into = createDiv();
		expect(await gloss.render(m, { unit: "p3", link: 2 }, into, new Component())).toBe(true);
		expect(into.textContent).toBe("Fifteen.");
		const whole = createDiv();
		expect(await gloss.render(m, { unit: "p3", link: null }, whole, new Component())).toBe(true);
		expect(Array.from(whole.querySelectorAll("p"), (p) => p.textContent)).toEqual(["Thirteen fourteen.", "Fifteen."]);
	});

	it("glosses links of a 2-1 unit that cross into, or live in, the second source paragraph, and places the slot after their last fragment", async () => {
		// Links: "Seis siete" | "ocho. Nueve" (crosses) | "Diez once." (second paragraph only).
		const source = ["Seis siete ocho. ^p1", "", "Nueve. Diez once. ^p2", ""].join("\n");
		const target = [
			"Six seven eight. Nine. Ten eleven. ^p1",
			"",
			`%%menard:1 p1+p2 ${sig("Seis siete")}/${sig("Six seven")} ${sig("ocho Nueve")}/${sig("eight Nine")} ${sig("Diez once")}/${sig("Ten eleven")}%%`,
			"",
		].join("\n");
		const options = { textStartHeading: "", skipHeadings: [] };
		const m = buildPairModel({
			sourcePath: SOURCE_PATH,
			targetPath: TARGET_PATH,
			languages: { source: "es", target: "en" },
			version: 1,
			source: parseNote(source, options),
			target: parseNote(target, options),
		});
		expect(m.problems).toEqual([]);
		expect(m.stops().map((s) => `${s.unit}.${s.link}`)).toEqual(["p1.1", "p1.2", "p1.3"]);
		const fake = fakeApp({ [SOURCE_PATH]: source, [TARGET_PATH]: target });
		vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
			const p = document.createElement("p");
			p.textContent = markdown;
			el.appendChild(p);
			return Promise.resolve();
		});
		const gloss = new OffscreenGloss(fake.app);
		const glossOf = async (link: number): Promise<string> => {
			const into = createDiv();
			expect(await gloss.render(m, { unit: "p1", link }, into, new Component())).toBe(true);
			return into.textContent ?? "";
		};
		expect(await glossOf(2)).toBe("eight. Nine.");
		expect(await glossOf(3)).toBe("Ten eleven.");

		// The stacked slot goes after the link's last source fragment: in the second paragraph for both.
		const processor = createPostProcessor(fakeContext(fake.app), new FakePairs(m), { sectionRendered: vi.fn() });
		const first = section("<p>Seis siete ocho.</p>");
		const second = section("<p>Nueve. Diez once.</p>");
		await processor(first, fakeSection({ sourcePath: SOURCE_PATH, text: source, lineStart: 0 }).ctx);
		await processor(second, fakeSection({ sourcePath: SOURCE_PATH, text: source, lineStart: 2 }).ctx);
		const container = createDiv();
		container.append(first, second);
		const scroller = createDiv();
		scroller.append(container);
		const owner = new Component();
		owner.load();
		const slot = new StackedGloss(gloss, owner);
		for (const [link, before] of [
			[2, "Nueve."],
			[3, "Diez once."],
		] as const) {
			await slot.show(container, scroller, m, { unit: "p1", link }, false);
			const shown = container.querySelectorAll(`.${CLS.gloss}`);
			expect(shown).toHaveLength(1);
			expect(second.contains(shown[0] as Node)).toBe(true);
			expect((shown[0] as HTMLElement).previousElementSibling?.textContent).toBe(before);
		}
	});
});
