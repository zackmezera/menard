import { describe, expect, it } from "vitest";
import { bookParent } from "../../src/import/commands";

describe("bookParent", () => {
	const root = { name: "", path: "/", parent: null };
	const texts = { name: "Texts", path: "Collections/Texts", parent: root };
	it("climbs out of a book folder so books are not nested", () => {
		expect(bookParent({ name: "@molloyletras1979", path: "Collections/Texts/@molloyletras1979", parent: texts })).toBe("Collections/Texts");
	});
	it("keeps an ordinary folder and maps the root to empty", () => {
		expect(bookParent(texts)).toBe("Collections/Texts");
		expect(bookParent(root)).toBe("");
		expect(bookParent(null)).toBe("");
	});
});

import { findExistingBook } from "../../src/import/epub";

describe("findExistingBook", () => {
	const meta = { title: "Las letras de Borges y otros ensayos", creator: "Sylvia Molloy", year: "2013", language: "es", publisher: "" };
	const hub = { basename: "@molloyletras1979", folder: "Collections/Texts", aliases: ["Las letras de Borges"] };
	it("reuses the note whose alias the EPUB title starts with", () => {
		expect(findExistingBook(meta, [hub, { basename: "@molloyborges1996", folder: "Collections/Texts", aliases: ["Borges y la educación de la memoria"] }])).toEqual({ citekey: "molloyletras1979", folder: "Collections/Texts" });
	});
	it("falls back to the same key with another year, and gives up when unsure", () => {
		expect(findExistingBook(meta, [{ ...hub, aliases: [] }])).toEqual({ citekey: "molloyletras1979", folder: "Collections/Texts" });
		expect(findExistingBook(meta, [{ ...hub, aliases: [] }, { ...hub, basename: "@molloyletras1999", aliases: [] }])).toBeNull();
		expect(findExistingBook(meta, [])).toBeNull();
	});
});

import { chaptersSection } from "../../src/import/commands";

describe("chaptersSection", () => {
	const links = ["[[@k/01 A|01 A]]", "[[@k/02 B|02 B]]"];
	it("appends a Chapters list after the existing body", () => {
		expect(chaptersSection("# Book\n\n![[Text.base]]\n", links)).toEqual([{ at: 23, text: "\n## Chapters\n\n- [[@k/01 A|01 A]]\n- [[@k/02 B|02 B]]\n" }]);
	});
	it("goes before the body's first divider, above the note's own sections", () => {
		const note = "---\ncitekey: k\n---\n# Book\n\n![[Text.base]]\n\n---\n\n### Argument\n";
		const [insert] = chaptersSection(note, links) as { at: number; text: string }[];
		const result = note.slice(0, insert!.at) + insert!.text + note.slice(insert!.at);
		expect(result).toBe("---\ncitekey: k\n---\n# Book\n\n![[Text.base]]\n\n## Chapters\n\n- [[@k/01 A|01 A]]\n- [[@k/02 B|02 B]]\n\n---\n\n### Argument\n");
	});

	it("leaves a note that already lists its chapters", () => {
		expect(chaptersSection("# Book\n\n## Chapters\n\n- old\n", links)).toBe("noop");
	});
});

import { edition, pdfNote } from "../../src/import/commands";

describe("pdfNote and edition", () => {
	const pages = [112, 113, 129].map((n) => ({ index: n + 15, label: null, items: [] }));
	it("names the PDF and the printed page range", () => {
		expect(edition("Signs of Borges.pdf", pages, (p) => String(p.index - 15))).toBe("Signs of Borges, pp. 112–129");
		expect(edition("Book.PDF", pages.slice(0, 1), (p) => String(p.index - 15))).toBe("Book, p. 112");
	});
	it("writes string properties as quoted YAML above the body", () => {
		expect(pdfNote({ source: "[[07 Title]]", sourceLanguage: "es" }, "Body.")).toBe('---\nsource: "[[07 Title]]"\nsourceLanguage: "es"\n---\n\nBody.\n');
	});
});
