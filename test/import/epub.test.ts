// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { chapterBasename, chapterNote, hubNote, readEpub, resolvePath, sourceEdition, suggestCitekey } from "../../src/import/epub";
import { openZip } from "../../src/import/zip";
import { filler, makeZip, sampleBook, toMarkdown } from "./fixtures";

async function plan(entries = sampleBook()) {
	return readEpub(openZip(await makeZip(entries, ["mimetype"])), toMarkdown);
}

describe("zip reader", () => {
	it("reads stored and deflated entries and reports missing ones", async () => {
		const zip = openZip(await makeZip({ a: "stored text", "dir/b.txt": "déjà vu ".repeat(50) }, ["a"]));
		expect(zip.names()).toEqual(["a", "dir/b.txt"]);
		expect(await zip.text("a")).toBe("stored text");
		expect(await zip.text("dir/b.txt")).toBe("déjà vu ".repeat(50));
		expect(await zip.read("missing")).toBeNull();
	});

	it("rejects a file that is not a zip", () => {
		expect(() => openZip(new TextEncoder().encode("not a zip at all, just text"))).toThrow(/not a zip/);
	});
});

describe("readEpub", () => {
	it("reads the metadata and suggests a Better BibTeX style citekey", async () => {
		const { meta } = await plan();
		expect(meta).toEqual({ title: "Las aguas del río", creator: "Ana Pérez", year: "2001", language: "es", publisher: "Editorial Ficticia" });
		expect(suggestCitekey(meta)).toBe("perezaguas2001");
		expect(suggestCitekey({ ...meta, creator: "de la Torre, Ana", title: "The Book" })).toBe("delatorrebook2001");
		expect(sourceEdition(meta)).toBe("Editorial Ficticia, 2001 (EPUB)");
	});

	it("makes one chapter per top-level TOC entry; untitled files join the previous chapter", async () => {
		const { chapters, skipped } = await plan();
		expect(chapters.map((c) => [c.number, c.title, c.files.map((f) => f.split("/").pop())])).toEqual([
			[1, "Uno: el agua", ["c1.xhtml", "c1b.xhtml"]],
			[2, "Dos", ["c2.xhtml"]],
		]);
		expect(skipped.map((s) => [s.file.split("/").pop(), s.reason])).toEqual([
			["cover.xhtml", "cover"],
			["notes.xhtml", "short front or back matter"],
		]);
	});

	it("turns backlink notes into Markdown footnotes at the end of the chapter", async () => {
		const [one] = (await plan()).chapters;
		expect(one!.footnotes).toBe(2);
		expect(one!.markdown).toContain("“comillas” —y raya— aquí.[^1] el río");
		expect(one!.markdown).toMatch(/\.\[\^2\]\n/);
		expect(one!.markdown).toMatch(/\[\^1\]: Nota uno con \*\*negrita\*\*\.\n\[\^2\]: Nota dos\.$/);
		expect(one!.markdown).not.toContain("backlink");
		expect(one!.markdown).not.toContain("---");
	});

	it("keeps italics from CSS classes, headings, and the continuation file", async () => {
		const [one] = (await plan()).chapters;
		expect(one!.markdown.startsWith("# Uno: el agua\n\nPrimera frase con *cursiva* y")).toBe(true);
		expect(one!.markdown).toContain("## Sección");
		expect(one!.markdown).toContain("continuación");
	});

	it("puts an inline page marker where a page break was", async () => {
		const [one] = (await plan()).chapters;
		expect(one!.pageMarkers).toBe(1);
		expect(one!.markdown).toContain("antes %%p. 7%% después");
	});

	it("resolves endnotes in another spine file and numbers a repeated reference once", async () => {
		const [, two] = (await plan()).chapters;
		expect(two!.footnotes).toBe(1);
		expect(two!.markdown).toContain("final[^1] y otra vez[^1].");
		expect(two!.markdown).toMatch(/\[\^1\]: Una nota al final del libro\.$/);
	});

	it("reads an EPUB 3 nav document and its page list", async () => {
		const book = sampleBook();
		book["OEBPS/content.opf"] = book["OEBPS/content.opf"]!.replace(
			'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
			'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
		).replace('<spine toc="ncx">', "<spine>");
		book["OEBPS/nav.xhtml"] =
			'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
			'<nav epub:type="toc"><ol><li><a href="text/c1.xhtml">Uno</a><ol><li><a href="text/c1.xhtml#s2">Sección</a></li></ol></li><li><a href="text/c2.xhtml">Dos</a></li></ol></nav>' +
			'<nav epub:type="page-list"><ol><li><a href="text/c2.xhtml#p9">9</a></li></ol></nav></body></html>';
		book["OEBPS/text/c2.xhtml"] = book["OEBPS/text/c2.xhtml"]!.replace("<h1>Dos</h1><p>", '<h1>Dos</h1><p><span id="p9"/>');
		const { chapters } = await plan(book);
		expect(chapters.map((c) => c.title)).toEqual(["Uno", "Dos"]);
		expect(chapters[1]!.markdown).toMatch(/^# Dos\n\n%%p\. 9%% el río/);
	});

	it("parses XHTML with HTML entities by falling back to the HTML parser", async () => {
		const book = sampleBook();
		book["OEBPS/text/c2.xhtml"] = book["OEBPS/text/c2.xhtml"]!.replace("<h1>Dos</h1>", "<h1>Dos&nbsp;bis</h1>");
		const { chapters } = await plan(book);
		expect(chapters[1]!.markdown).toMatch(/^# Dos\sbis\n\nel río/);
	});

	it("titles a chapter from its first heading when the book has no TOC", async () => {
		const book = sampleBook();
		delete book["OEBPS/toc.ncx"];
		book["OEBPS/content.opf"] = book["OEBPS/content.opf"]!.replace('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', "");
		book["OEBPS/text/c1b.xhtml"] = book["OEBPS/text/c1b.xhtml"]!.replace("<p>", "<h2>Aparte</h2><p>");
		const { chapters } = await plan(book);
		expect(chapters.map((c) => c.title)).toEqual(["Uno: el agua", "Aparte", "Dos"]);
	});
});

describe("note text", () => {
	it("names chapter files NN Title without path or link characters", () => {
		expect(chapterBasename({ number: 3, title: "VI. Placer: el hiato / [otro]" }, 2)).toBe("03 VI. Placer - el hiato otro");
		expect(chapterBasename({ number: 12, title: "?" }, 3)).toBe("012 Chapter");
	});

	it("writes the chapter frontmatter and the hub", async () => {
		const [one] = (await plan()).chapters;
		const note = chapterNote(one!, { citekey: "perezaguas2001", language: "es", edition: "Editorial Ficticia, 2001 (EPUB)" });
		expect(note.split("\n").slice(0, 8)).toEqual([
			"---",
			"originalLanguage: es",
			'book: "[[@perezaguas2001]]"',
			"chapter: 1",
			'sourceEdition: "Editorial Ficticia, 2001 (EPUB)"',
			"pageSource: epub-pagelist",
			"---",
			"# Uno: el agua",
		]);
		expect(hubNote({ title: "T", creator: "", year: "", language: "", publisher: "" }, "k", ["[[@k/01 A]]"])).toBe(
			"---\ncitekey: k\n---\n# T\n\n- [[@k/01 A]]\n",
		);
	});

	it("resolves relative hrefs", () => {
		expect(resolvePath("OEBPS/text/a.xhtml", "../img/b%20c.jpg")).toBe("OEBPS/img/b c.jpg");
		expect(resolvePath("OEBPS/text/a.xhtml", "#n1")).toBe("OEBPS/text/a.xhtml#n1");
		expect(filler(3)).toBe("el río corre");
	});
});
