import { describe, expect, it } from "vitest";
import { pageLines, pageOpenings, pdfToMarkdown, readPdfPages, stripFurniture } from "../../src/import/pdf";
import type { PdfItem, PdfJsDocument, PdfPage } from "../../src/import/pdf";

const MARGIN = 72;
const SIZE = 10;
const LEADING = 12;
const CHAR = 5; // a monospaced page: width = characters × 5

/** One text item per line; `indent` in points, `size` overrides the body size. */
function line(str: string, y: number, options: { x?: number; size?: number } = {}): PdfItem {
	const size = options.size ?? SIZE;
	return { str, transform: [size, 0, 0, size, options.x ?? MARGIN, y], width: str.length * CHAR * (size / SIZE) };
}

/** A page: an optional running head, body lines top-down (null for a blank line), an optional folio. */
function page(index: number, head: string | null, body: (PdfItem | string | null)[], folio = true): PdfPage {
	const items: PdfItem[] = [];
	if (head !== null) items.push(line(head, 600));
	let y = 570;
	for (const entry of body) {
		if (entry !== null) items.push(typeof entry === "string" ? line(entry, y) : { ...entry, transform: [...entry.transform.slice(0, 5), y] });
		y -= LEADING;
	}
	if (folio) items.push(line(String(index + 10), 40, { x: 200 }));
	return { index, label: null, items };
}

const FULL = "x".repeat(60); // a full-width line is 300pt

describe("pageLines", () => {
	it("joins the items of one baseline in x order and spaces separate words", () => {
		const lines = pageLines([
			{ str: "world", transform: [10, 0, 0, 10, 110, 500], width: 25 },
			{ str: "hello", transform: [10, 0, 0, 10, 72, 500.4], width: 25 },
			{ str: "next line", transform: [10, 0, 0, 10, 72, 488], width: 45 },
		]);
		expect(lines.map((l) => l.text)).toEqual(["hello world", "next line"]);
	});
});

describe("stripFurniture", () => {
	it("drops a running head that recurs, a head with a page number, and bare folios", () => {
		const pages = [
			page(1, "An Invented Book", [FULL, "first page text."]),
			page(2, "Chapter Title 13", [FULL, "second page text."]),
			page(3, "An Invented Book", [FULL, "third page text."]),
		].map((p) => pageLines(p.items));
		const texts = stripFurniture(pages).map((lines) => lines.map((l) => l.text));
		expect(texts).toEqual([
			[FULL, "first page text."],
			[FULL, "second page text."],
			[FULL, "third page text."],
		]);
	});
});

const words = (prefix: string): string => `${prefix} ${"word ".repeat(12)}`.slice(0, 60).replace(/ $/, "s");

describe("pdfToMarkdown", () => {
	it("rejoins lines, dehyphenates, breaks at indents and short closing lines, and marks page starts", () => {
		const pages = [
			page(1, "An Invented Book", [
				words("The first paragraph"),
				"ends right here.",
				line(words("An indented second"), 0, { x: MARGIN + 15 }),
				"line goes on with a broken hyphen-",
			]),
			page(2, "An Invented Book", [
				"ated word and the paragraph runs to its very end on this line now ok.",
				line(words("Third paragraph"), 0, { x: MARGIN + 15 }),
				"closes.",
				null,
				line("1 A small note in small type at the foot.", 0, { size: 8 }),
			]),
		];
		const blocks = pdfToMarkdown(pages, { label: (p) => String(p.index + 100) }).split("\n\n");
		expect(blocks).toEqual([
			`%%p. 101%% ${words("The first paragraph")} ends right here.`,
			`${words("An indented second")} line goes on with a broken hyphenated %%p. 102%% word and the paragraph runs to its very end on this line now ok.`,
			`${words("Third paragraph")} closes.`,
			"## Notes",
			"%%p. 102%% 1 A small note in small type at the foot.",
		]);
		expect(blocks.join(" ")).not.toContain("Invented Book");
	});

	it("keeps a chapter's display number and title as its heading, and epigraphs before the body as paragraphs", () => {
		const quote = (str: string, x = MARGIN + 18): PdfItem => line(str, 0, { x, size: 9 });
		const pages = [
			page(
				1,
				null,
				[
					line("7", 0, { x: 200, size: 20 }),
					line("The Buried Foundation", 0, { x: 140, size: 18 }),
					null,
					quote("An epigraph in small type that runs over"),
					quote("two lines."),
					quote("A. Poet, Works", MARGIN + 100),
					null,
					FULL,
					"body ends.",
				],
				false,
			),
			page(2, "The Buried Foundation", [FULL, "more body."], false),
		];
		expect(pdfToMarkdown(pages, { label: (p) => String(p.index) }).split("\n\n")).toEqual([
			"# 7. The Buried Foundation",
			"%%p. 1%% An epigraph in small type that runs over two lines.",
			"A. Poet, Works",
			`${FULL} body ends.`,
			`%%p. 2%% ${FULL} more body.`,
		]);
	});

	it("turns inset small type mid-page into one quotation, joined and dehyphenated across a page", () => {
		const inset = (str: string, x = MARGIN + 18): PdfItem => line(str, 0, { x, size: 9 });
		const pages = [
			page(1, null, [FULL, "and he wrote:", inset("A quotation set in small type, inset", MARGIN + 36), inset("at both margins, with an exam-"), inset("ple that breaks over the page and")], false),
			page(2, null, [inset("ends here. (Q 12)"), line(words("Body resumes"), 0, { x: MARGIN + 15 }), FULL, "and closes."], false),
		];
		expect(pdfToMarkdown(pages, { label: (p) => String(p.index) }).split("\n\n")).toEqual([
			`%%p. 1%% ${FULL} and he wrote:`,
			"> A quotation set in small type, inset at both margins, with an example that breaks over the page and %%p. 2%% ends here. (Q 12)",
			`${words("Body resumes")} ${FULL} and closes.`,
		]);
	});

	it("makes a short line set off by space a section heading, joining one split over two lines", () => {
		const head = (str: string): PdfItem => line(str, 0, { x: MARGIN + 60, size: 11 });
		const pages = [page(1, null, [FULL, "the end of a section.", null, head("Heterogeneous Enumeration:"), head("Signaling the Interstice"), null, FULL, "next section."], false)];
		expect(pdfToMarkdown(pages, { label: (p) => String(p.index) }).split("\n\n")).toEqual([
			`%%p. 1%% ${FULL} the end of a section.`,
			"## Heterogeneous Enumeration: Signaling the Interstice",
			`${FULL} next section.`,
		]);
	});

	it("starts a page's marker inline when the paragraph continues across the page", () => {
		const pages = [page(1, null, [words("Opening"), words("still going")], false), page(2, null, [words("and on"), "to the end."], false)];
		expect(pdfToMarkdown(pages, { label: (p) => String(p.index) })).toBe(
			`%%p. 1%% ${words("Opening")} ${words("still going")} %%p. 2%% ${words("and on")} to the end.`,
		);
	});
});

describe("pageOpenings and readPdfPages", () => {
	it("gives each page's first letters without its running head", () => {
		const pages = [page(1, "An Invented Book", ["Él dijo: “u n a vez”, y calló.", FULL]), page(2, "An Invented Book", ["Otra página.", FULL])];
		const [first] = pageOpenings(pages, (p) => String(p.index), 12);
		expect(first).toEqual({ label: "1", opening: "eldijounavez", letters: expect.any(Number) as number });
	});

	it("reads labels and text items through a pdf.js-like document", async () => {
		const doc: PdfJsDocument = {
			numPages: 3,
			getPageLabels: () => Promise.resolve(["i", "1", "2"]),
			getPage: (n) => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: `p${n}`, transform: [1, 0, 0, 1, 0, 0], width: 1 }, { type: "beginMarkedContent" }] }) }),
		};
		const pages = await readPdfPages(doc, 2, 9);
		expect(pages.map((p) => [p.index, p.label, p.items.length])).toEqual([
			[2, "1", 1],
			[3, "2", 1],
		]);
	});
});
