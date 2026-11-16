/**
 * Synthetic import fixtures: a tiny zip writer, a stand-in for Obsidian's
 * htmlToMarkdown, and an invented EPUB. No text from real books.
 */

/** A zip of the given entries; `stored` names are not compressed. CRCs are zero (the reader ignores them). */
export async function makeZip(entries: Record<string, string>, stored: string[] = []): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(entries)) {
		const raw = encoder.encode(content);
		const deflate = !stored.includes(name);
		const data = deflate ? await deflateRaw(raw) : raw;
		const nameBytes = encoder.encode(name);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, deflate ? 8 : 0, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, deflate ? 8 : 0, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		locals.push(local);
		centrals.push(central);
		offset += local.length;
	}
	const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, centrals.length, true);
	ev.setUint16(10, centrals.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + centralSize + 22);
	let at = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A small HTML → Markdown converter standing in for Obsidian's htmlToMarkdown. */
export function toMarkdown(root: HTMLElement): string {
	const out: string[] = [];
	const inline = (node: Node): string => {
		if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
		if (node.nodeType !== 1) return "";
		const el = node as Element;
		const inner = Array.from(el.childNodes).map(inline).join("");
		const name = el.localName.toLowerCase();
		if (name === "em" || name === "i") return `*${inner}*`;
		if (name === "strong" || name === "b") return `**${inner}**`;
		if (name === "a") return `[${inner}](${el.getAttribute("href") ?? ""})`;
		return inner;
	};
	const block = (node: Node): void => {
		if (node.nodeType !== 1) {
			const text = inline(node).trim();
			if (text) out.push(text);
			return;
		}
		const el = node as Element;
		const name = el.localName.toLowerCase();
		const heading = /^h([1-6])$/.exec(name);
		const hasBlocks = Array.from(el.children).some((child) => /^(p|div|h\d|section|aside|blockquote|ol|ul)$/i.test(child.localName));
		if (heading) out.push(`${"#".repeat(Number(heading[1]))} ${inline(el).trim()}`);
		else if (hasBlocks) Array.from(el.childNodes).forEach(block);
		else {
			const text = inline(el).trim();
			if (text) out.push(text);
		}
	};
	Array.from(root.childNodes).forEach(block);
	return out.join("\n\n");
}

/** Invented filler: `n` words of a made-up sentence. */
export function filler(n: number, seed = "lorem"): string {
	const words = ["el", "río", "corre", "lento", "bajo", "puentes", "de", "piedra", "mientras", "la", "ciudad", "duerme", seed];
	return Array.from({ length: n }, (_, i) => words[i % words.length]).join(" ");
}

const xhtml = (body: string, title = "x"): string =>
	`<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;

/**
 * An EPUB 2 book: cover (skipped), chapter one (calibre-style backlink notes,
 * an italic class, a self-closing page break), an untitled continuation file
 * (joins chapter one), chapter two (typed noteref to an endnotes file), and
 * the endnotes file (emptied by the import, skipped).
 */
export function sampleBook(): Record<string, string> {
	return {
		mimetype: "application/epub+zip",
		"META-INF/container.xml":
			'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		"OEBPS/content.opf": `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
<metadata><dc:title>Las aguas del río</dc:title><dc:creator>Ana Pérez</dc:creator><dc:date>2001-05-01</dc:date><dc:language>ES</dc:language><dc:publisher>Editorial Ficticia</dc:publisher></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="css/book.css" media-type="text/css"/>
<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
<item id="c1b" href="text/c1b.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
<item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c1b"/><itemref idref="c2"/><itemref idref="notes"/></spine>
<guide><reference type="cover" href="text/cover.xhtml" title="Cover"/></guide>
</package>`,
		"OEBPS/toc.ncx": `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1"><navLabel><text>Uno: el agua</text></navLabel><content src="text/c1.xhtml"/>
<navPoint id="n1a"><navLabel><text>Sección</text></navLabel><content src="text/c1.xhtml#s2"/></navPoint></navPoint>
<navPoint id="n2"><navLabel><text>Dos</text></navLabel><content src="text/c2.xhtml"/></navPoint>
</navMap></ncx>`,
		"OEBPS/css/book.css": ".cur { font-style: italic; }\n.neg { font-weight: bold; }",
		"OEBPS/text/cover.xhtml": xhtml('<div><p>Las aguas del río</p></div>'),
		"OEBPS/text/c1.xhtml": xhtml(
			`<h1>Uno: el agua</h1>
<p>Primera frase con <span class="cur">cursiva</span> y “comillas” —y raya— aquí.<span class="Footnote"><a class="footnote-link" href="#fn-1" id="fn-1-backlink">1</a></span> ${filler(40)}</p>
<h2 id="s2">Sección</h2>
<p>${filler(20)} antes<span epub:type="pagebreak" id="pg7" title="7"/> después ${filler(10)}.<sup><a href="#fn-2" id="fn-2-backlink">2</a></sup></p>
<div class="footnotes"><div class="footnote"><p><a href="#fn-1-backlink" id="fn-1">1</a> Nota uno con <span class="neg">negrita</span>.</p></div>
<div class="footnote"><p><a href="#fn-2-backlink" id="fn-2">2</a> Nota dos.</p></div></div>`,
		),
		"OEBPS/text/c1b.xhtml": xhtml(`<p>${filler(70, "continuación")}</p>`),
		"OEBPS/text/c2.xhtml": xhtml(
			`<h1>Dos</h1><p>${filler(30)} final<a epub:type="noteref" href="notes.xhtml#en1">1</a> y otra vez<a epub:type="noteref" href="notes.xhtml#en1">1</a>.</p><p>${filler(40)}</p>`,
		),
		"OEBPS/text/notes.xhtml": xhtml('<h1>Notas</h1><aside epub:type="endnote" id="en1"><p>Una nota al final del libro.</p></aside>'),
	};
}
