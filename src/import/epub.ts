/**
 * EPUB → chapter notes, as a pure plan: reads container.xml, the OPF, the
 * TOC (EPUB 3 nav or NCX) and the spine, groups spine files into chapters,
 * turns note references into Markdown footnotes and page breaks into
 * `%%p. N%%` markers, and converts each chapter to Markdown with an injected
 * HTML → Markdown function (Obsidian's `htmlToMarkdown` in the app). Writes
 * nothing. Owner: import module. DESIGN.md §16.
 */
import type { ZipArchive } from "./zip";

export interface BookMeta {
	title: string;
	creator: string;
	/** Four-digit year from dc:date, or "". */
	year: string;
	/** dc:language as given, lowercased; "" when absent. */
	language: string;
	publisher: string;
}

export interface PlannedChapter {
	/** 1-based spine order among the chapters produced. */
	number: number;
	title: string;
	/** Chapter body: Markdown with `[^n]` footnotes (definitions at the end) and `%%p. N%%` markers. */
	markdown: string;
	words: number;
	footnotes: number;
	pageMarkers: number;
	/** Spine files the chapter was built from. */
	files: string[];
}

export interface SkippedFile {
	file: string;
	words: number;
	reason: string;
}

export interface BookPlan {
	meta: BookMeta;
	chapters: PlannedChapter[];
	skipped: SkippedFile[];
}

/** Obsidian's `htmlToMarkdown` in the app; a stand-in in tests. */
export type ToMarkdown = (element: HTMLElement) => string;

/** Spine files with fewer words than this, outside the TOC's chapter starts, are skipped and reported. */
export const MIN_WORDS = 60;

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const NOTE_TYPES = /\b(footnote|endnote|rearnote|note)\b/;
const NOTE_ROLES = /\bdoc-(footnote|endnote)\b/;
const FN_TOKEN = (k: number): string => `⟦fn${k}⟧`;
const PG_TOKEN = (k: number): string => `⟦pg${k}⟧`;

interface TocEntry {
	label: string;
	file: string;
}

interface NoteDef {
	element: Element;
}

export async function readEpub(zip: ZipArchive, toMarkdown: ToMarkdown): Promise<BookPlan> {
	const container = await need(zip, "META-INF/container.xml");
	const opfPath = attr(byTag(xml(container), "rootfile")[0], "full-path");
	if (!opfPath) throw new Error("This EPUB has no package document.");
	const opf = xml(await need(zip, opfPath));

	const meta = readMeta(opf);
	const manifest = new Map<string, { href: string; type: string; properties: string }>();
	for (const item of byTag(opf, "item")) {
		manifest.set(attr(item, "id"), {
			href: resolvePath(opfPath, attr(item, "href")),
			type: attr(item, "media-type"),
			properties: attr(item, "properties"),
		});
	}
	const spineEl = byTag(opf, "spine")[0];
	const spine = byTag(opf, "itemref")
		.map((ref) => manifest.get(attr(ref, "idref")))
		.filter((item) => item !== undefined && /html/.test(item.type))
		.map((item) => item!.href);

	const docs = new Map<string, Document>();
	for (const file of spine) docs.set(file, xhtml(await need(zip, file)));

	const styles = await styleClasses(zip, [...manifest.values()].filter((item) => item.type === "text/css").map((item) => item.href));
	const navItem = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties));
	const ncxItem = manifest.get(spineEl ? attr(spineEl, "toc") : "") ?? [...manifest.values()].find((item) => /ncx/.test(item.type));
	const { toc, pages } = navItem
		? readNav(xhtml(await need(zip, navItem.href)), navItem.href)
		: ncxItem
			? readNcx(xml(await need(zip, ncxItem.href)), ncxItem.href)
			: { toc: [], pages: [] };

	const pageLabels = markPages(docs, pages);
	const notes = markNotes(docs);
	for (const doc of docs.values()) tidy(doc.documentElement, styles);
	for (const note of notes) tidy(note.element, styles);

	const starts = new Map<string, string>();
	for (const entry of toc) {
		const [file] = splitHref(entry.file);
		if (!starts.has(file)) starts.set(file, entry.label);
	}
	const guide = new Map<string, string>();
	for (const ref of byTag(opf, "reference")) guide.set(splitHref(resolvePath(opfPath, attr(ref, "href")))[0], attr(ref, "type"));

	const groups: { title: string; files: string[]; fromToc: boolean }[] = [];
	const skipped: SkippedFile[] = [];
	for (const file of spine) {
		const body = docs.get(file)!.getElementsByTagName("body")[0] ?? docs.get(file)!.documentElement;
		const text = withoutTokens(body.textContent ?? "");
		const words = countWords(text);
		const label = starts.get(file);
		const previous = groups[groups.length - 1];
		if (label !== undefined) groups.push({ title: label, files: [file], fromToc: true });
		else if (words < MIN_WORDS) skipped.push({ file, words, reason: guide.get(file)?.replace(/-/g, " ") || kindOf(file, text) });
		else if (/\bISBN\b|©/.test(text) && words < 300) skipped.push({ file, words, reason: "copyright page" });
		else if (previous?.fromToc) previous.files.push(file);
		else groups.push({ title: headingOf(docs.get(file)!) ?? baseName(file), files: [file], fromToc: false });
	}

	const chapters = groups.map((group, index) => {
		const html = docs.get(group.files[0]!)!.implementation.createHTMLDocument("");
		const root = html.body;
		for (const file of group.files) {
			const body = docs.get(file)!.getElementsByTagName("body")[0];
			for (const child of Array.from(body?.childNodes ?? [])) root.appendChild(html.importNode(child, true));
		}
		const words = countWords(withoutTokens(root.textContent ?? ""));
		const built = finish(toMarkdown(root), notes, pageLabels, html, toMarkdown);
		return { number: index + 1, title: group.title, words, files: group.files, ...built };
	});
	return { meta, chapters, skipped };
}

/** Better BibTeX style: creator surname + first significant title word + year, lowercase ASCII. */
export function suggestCitekey(meta: BookMeta): string {
	const creator = meta.creator.includes(",") ? meta.creator.split(",")[0]! : (meta.creator.trim().split(/\s+/).pop() ?? "");
	const word = ascii(meta.title)
		.split(/[^a-z0-9]+/)
		.find((part) => part !== "" && !TITLE_SKIP.has(part));
	return ascii(creator).replace(/[^a-z0-9]/g, "") + (word ?? "") + meta.year;
}

/** A note already in the vault that may stand for this book. */
export interface BookCandidate {
	basename: string;
	folder: string;
	aliases: readonly string[];
}

/**
 * The vault's existing note for this book, so the import reuses its citekey
 * and sits beside it: an `@citekey` note with an alias that the EPUB title
 * starts with, else the only `@citekey` whose key is the suggested one with a
 * different year (the same work, another edition). Null when unsure.
 */
export function findExistingBook(meta: BookMeta, candidates: readonly BookCandidate[]): { citekey: string; folder: string } | null {
	const notes = candidates.filter((c) => c.basename.startsWith("@"));
	const title = normTitle(meta.title);
	const byAlias = notes.filter((c) => c.aliases.some((alias) => {
		const a = normTitle(alias);
		return a.length >= 8 && (title === a || title.startsWith(`${a} `));
	}));
	const stem = suggestCitekey(meta).replace(/\d+$/, "");
	const byKey = notes.filter((c) => new RegExp(`^@${stem}\\d{4}[a-z]?$`).test(c.basename));
	const pick = byAlias.length === 1 ? byAlias[0] : byAlias.length === 0 && byKey.length === 1 ? byKey[0] : undefined;
	return pick ? { citekey: pick.basename.slice(1), folder: pick.folder === "/" ? "" : pick.folder } : null;
}

function normTitle(value: string): string {
	return ascii(value).replace(/[^a-z0-9]+/g, " ").trim();
}

const TITLE_SKIP = new Set(
	"a an the of on in and to for el la los las lo un una unos unas de del y e o le les l des du et il lo gli i di die der das ein eine und os as um uma do da".split(" "),
);

/** "Publisher, 2013 (EPUB)". */
export function sourceEdition(meta: BookMeta): string {
	return [meta.publisher, meta.year].filter((part) => part !== "").join(", ") + " (EPUB)";
}

/** A file-name-safe chapter title, `NN Title`. */
export function chapterBasename(chapter: Pick<PlannedChapter, "number" | "title">, width: number): string {
	const title = chapter.title
		.replace(/\s*:\s*/g, " - ")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 80)
		.trim();
	return `${String(chapter.number).padStart(width, "0")} ${title || "Chapter"}`;
}

export interface ChapterProps {
	citekey: string;
	language: string;
	edition: string;
}

export function chapterNote(chapter: PlannedChapter, props: ChapterProps): string {
	const lines = [
		"---",
		`originalLanguage: ${yamlValue(props.language)}`,
		`book: ${JSON.stringify(`[[@${props.citekey}]]`)}`,
		`chapter: ${chapter.number}`,
		`sourceEdition: ${yamlValue(props.edition)}`,
		...(chapter.pageMarkers > 0 ? ["pageSource: epub-pagelist"] : []),
		"---",
		"",
	];
	return lines.join("\n") + chapter.markdown + "\n";
}

export function hubNote(meta: BookMeta, citekey: string, links: string[]): string {
	return ["---", `citekey: ${citekey}`, "---", `# ${meta.title}`, "", ...links.map((link) => `- ${link}`), ""].join("\n");
}

function yamlValue(value: string): string {
	return /^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(value) && !/^(true|false|null|yes|no)$/i.test(value) ? value : JSON.stringify(value);
}

// ---------------------------------------------------------------- metadata and TOC

function readMeta(opf: Document): BookMeta {
	const dc = (name: string): string => clean(byTag(opf, name)[0]?.textContent ?? "");
	return {
		title: dc("title"),
		creator: dc("creator"),
		year: /\d{4}/.exec(dc("date"))?.[0] ?? "",
		language: dc("language").toLowerCase(),
		publisher: dc("publisher"),
	};
}

function readNcx(ncx: Document, path: string): { toc: TocEntry[]; pages: TocEntry[] } {
	const navMap = byTag(ncx, "navMap")[0];
	let top = navMap ? children(navMap, "navPoint") : [];
	if (top.length === 1 && children(top[0]!, "navPoint").length > 1) top = children(top[0]!, "navPoint");
	const entry = (point: Element): TocEntry => ({
		label: clean(byTag(point, "text")[0]?.textContent ?? ""),
		file: resolvePath(path, attr(children(point, "content")[0], "src")),
	});
	return { toc: top.map(entry), pages: byTag(ncx, "pageTarget").map(entry) };
}

function readNav(nav: Document, path: string): { toc: TocEntry[]; pages: TocEntry[] } {
	const navs = byTag(nav, "nav");
	const typed = (kind: string): Element | undefined =>
		navs.find((el) => attr(el, "epub:type").split(/\s+/).includes(kind) || attr(el, "role") === `doc-${kind === "toc" ? "toc" : "pagelist"}`);
	const links = (el: Element | undefined, topOnly: boolean): TocEntry[] => {
		if (!el) return [];
		let anchors = byTag(el, "a");
		if (topOnly) {
			const list = byTag(el, "ol")[0];
			let items = list ? children(list, "li") : [];
			if (items.length === 1) items = byTag(items[0]!, "li").filter((li) => li.parentElement?.parentElement === items[0]);
			anchors = items.map((li) => byTag(li, "a")[0]).filter((a): a is Element => a !== undefined);
		}
		return anchors.map((a) => ({ label: clean(a.textContent ?? ""), file: resolvePath(path, attr(a, "href")) }));
	};
	return { toc: links(typed("toc"), true), pages: links(typed("page-list"), false) };
}

// ---------------------------------------------------------------- notes and pages

/** Replaces page-break elements and page-list targets with page tokens; returns the labels by token index. */
function markPages(docs: Map<string, Document>, pages: TocEntry[]): string[] {
	const labels: string[] = [];
	const done = new Set<Element>();
	const mark = (el: Element, label: string): void => {
		if (done.has(el) || label === "") return;
		done.add(el);
		const token = el.ownerDocument.createTextNode(PG_TOKEN(labels.length));
		labels.push(label);
		if ((el.textContent ?? "").trim() === "" || isPageBreak(el)) el.replaceWith(token);
		else el.parentNode?.insertBefore(token, el);
	};
	for (const doc of docs.values()) {
		for (const el of Array.from(doc.getElementsByTagName("*"))) {
			if (isPageBreak(el)) mark(el, clean(attr(el, "title") || attr(el, "aria-label") || (el.textContent ?? "")));
		}
	}
	for (const page of pages) {
		const [file, id] = splitHref(page.file);
		const el = id ? ids(docs.get(file)).get(id) : undefined;
		if (el) mark(el, page.label);
	}
	return labels;
}

function isPageBreak(el: Element): boolean {
	return attr(el, "epub:type").split(/\s+/).includes("pagebreak") || attr(el, "role") === "doc-pagebreak";
}

/**
 * Finds note references across all spine files: a link whose target is
 * typed as a note, or is itself typed as a noteref, or whose target block
 * links back to it (calibre and InDesign "…-backlink" anchors). Replaces each
 * reference with a footnote token and detaches its definition.
 */
function markNotes(docs: Map<string, Document>): NoteDef[] {
	const index = new Map<string, Map<string, Element>>();
	for (const [file, doc] of docs) index.set(file, ids(doc));
	const links: { anchor: Element; target: Element }[] = [];
	for (const [file, doc] of docs) {
		for (const anchor of byTag(doc, "a")) {
			const href = attr(anchor, "href");
			if (href === "" || /^[a-z]+:/i.test(href)) continue;
			const [targetFile, id] = splitHref(resolvePath(file, href));
			const target = id ? index.get(targetFile)?.get(id) : undefined;
			if (target && !target.contains(anchor)) links.push({ anchor, target });
		}
	}
	const targets = new Set(links.map((link) => link.target));
	const pairs: { anchor: Element; def: Element }[] = [];
	for (const { anchor, target } of links) {
		const def = definitionOf(target, targets);
		const typed = NOTE_TYPES.test(attr(anchor, "epub:type")) || attr(anchor, "role") === "doc-noteref";
		const refIds = [anchor, anchor.parentElement].map((el) => (el ? attr(el, "id") : "")).filter((x) => x !== "");
		// A backlink pair counts in the direction whose target opens its block: the note, not the body paragraph.
		const backlinks = startsBlock(target, def) && byTag(def, "a").some((a) => refIds.some((refId) => attr(a, "href").endsWith(`#${refId}`)));
		if (typed || isNoteContainer(def) || backlinks) pairs.push({ anchor, def });
	}
	const notes: NoteDef[] = [];
	const definitions = new Map<Element, number>();
	for (const { anchor, def } of pairs) {
		if (pairs.some((pair) => pair.def.contains(anchor))) continue;
		let k = definitions.get(def);
		if (k === undefined) {
			k = notes.length;
			definitions.set(def, k);
			notes.push({ element: def });
		}
		const wrapper = anchor.parentElement;
		const replaced =
			wrapper && /^(sup|span)$/i.test(wrapper.localName) && clean(wrapper.textContent ?? "") === clean(anchor.textContent ?? "") ? wrapper : anchor;
		replaced.replaceWith(anchor.ownerDocument.createTextNode(FN_TOKEN(k)));
	}
	for (const { element } of notes) {
		const parent = element.parentElement;
		// Backlinks ("1", "↩") are navigation, not note text.
		for (const a of byTag(element, "a")) if (!/^[a-z]+:/i.test(attr(a, "href")) && !/\p{L}/u.test(a.textContent ?? "")) a.remove();
		element.remove();
		pruneEmpty(parent);
	}
	return notes;
}

/** True when no text precedes `target` inside `block`. */
function startsBlock(target: Element, block: Element): boolean {
	const walk = (node: Node): boolean | null => {
		if (node === target) return true;
		if (node.nodeType === 3) return (node.textContent ?? "").trim() === "" ? null : false;
		for (const child of Array.from(node.childNodes)) {
			const found = walk(child);
			if (found !== null) return found;
		}
		return null;
	};
	return walk(block) === true;
}

function isNoteContainer(el: Element): boolean {
	return NOTE_TYPES.test(attr(el, "epub:type")) || NOTE_ROLES.test(attr(el, "role")) || el.localName === "aside";
}

/** The block holding a note's text: a typed note container, else the target's block grown while it holds no other link target. */
function definitionOf(target: Element, targets: Set<Element>): Element {
	for (let el: Element | null = target; el; el = el.parentElement) {
		if (isNoteContainer(el)) return el;
		if (/^(body|section|html)$/.test(el.localName)) break;
	}
	let block: Element = target;
	while (!/^(p|li|div|dd|aside|blockquote)$/.test(block.localName) && block.parentElement) block = block.parentElement;
	for (;;) {
		const parent = block.parentElement;
		if (!parent || /^(body|section|html)$/.test(parent.localName) || /^h\d$/.test(parent.localName)) return block;
		const others = Array.from(parent.querySelectorAll("[id]")).some((el) => el !== target && targets.has(el));
		if (others || parent.querySelector("h1,h2,h3,h4,h5,h6")) return block;
		block = parent;
	}
}

function pruneEmpty(el: Element | null): void {
	while (el && !/^(body|html)$/.test(el.localName) && clean(el.textContent ?? "") === "" && !el.querySelector("img")) {
		const parent = el.parentElement;
		el.remove();
		el = parent;
	}
}

/** Italic and bold class spans become em and strong; images, scripts and in-book links go. */
function tidy(root: Element, styles: { italic: Set<string>; bold: Set<string> }): void {
	const doc = root.ownerDocument;
	for (const el of Array.from(root.getElementsByTagName("*"))) {
		const name = el.localName;
		if (name === "img" || name === "script" || name === "style" || name === "svg") {
			el.remove();
			continue;
		}
		if (name === "a") {
			const href = attr(el, "href");
			if (!/^(https?|mailto):/i.test(href)) unwrap(el);
			continue;
		}
		if (name !== "span") continue;
		const classes = attr(el, "class").split(/\s+/).filter((c) => c !== "");
		const italic = classes.some((c) => styles.italic.has(c) || /italic|cursiva/i.test(c));
		const bold = classes.some((c) => styles.bold.has(c) || /bold|negrita/i.test(c));
		if (!italic && !bold) continue;
		let inner: Element = doc.createElementNS(XHTML_NS, italic ? "em" : "strong");
		const outer = inner;
		if (italic && bold) {
			inner = doc.createElementNS(XHTML_NS, "strong");
			outer.appendChild(inner);
		}
		while (el.firstChild) inner.appendChild(el.firstChild);
		el.replaceWith(outer);
	}
}

async function styleClasses(zip: ZipArchive, files: string[]): Promise<{ italic: Set<string>; bold: Set<string> }> {
	const italic = new Set<string>();
	const bold = new Set<string>();
	for (const file of files) {
		const css = (await zip.text(file)) ?? "";
		for (const [, selectors = "", body = ""] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			const classes = [...selectors.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
			if (/font-style\s*:\s*italic/i.test(body)) classes.forEach((c) => italic.add(c));
			if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(body)) classes.forEach((c) => bold.add(c));
		}
	}
	return { italic, bold };
}

// ---------------------------------------------------------------- Markdown

function finish(
	markdown: string,
	notes: NoteDef[],
	pageLabels: string[],
	html: Document,
	toMarkdown: ToMarkdown,
): { markdown: string; footnotes: number; pageMarkers: number } {
	const order: number[] = [];
	let pageMarkers = 0;
	let body = markdown.replace(/⟦fn(\d+)⟧/g, (_, k: string) => {
		const at = order.indexOf(Number(k));
		if (at >= 0) return `[^${at + 1}]`;
		order.push(Number(k));
		return `[^${order.length}]`;
	});
	body = body.replace(/[ \t]*⟦pg(\d+)⟧[ \t]*/g, (match, k: string, offset: number, all: string) => {
		pageMarkers++;
		const marker = `%%p. ${pageLabels[Number(k)]}%%`;
		const lineStart = offset === 0 || all[offset - 1] === "\n";
		const lineEnd = offset + match.length === all.length || all[offset + match.length] === "\n";
		return lineStart && lineEnd ? marker : lineStart ? `${marker} ` : lineEnd ? ` ${marker}` : ` ${marker} `;
	});
	// A marker alone on a line opens the next paragraph, unless that is a heading.
	body = body.replace(/^((?:%%p\. [^%\n]+%%[ ]?)+)\n+(?=[^#>*|\-\s])/gm, (_, markers: string) => `${markers.trim()} `);
	const definitions = order.map((k, i) => {
		const root = html.implementation.createHTMLDocument("").body;
		root.appendChild(root.ownerDocument.importNode(notes[k]!.element, true));
		const text = toMarkdown(root)
			.replace(/⟦pg\d+⟧/g, "")
			.trim()
			.replace(/^\d+\\?[.)]?\s+/, "")
			.replace(/\n{2,}/g, "\n\n    ");
		return `[^${i + 1}]: ${text}`;
	});
	body = body.replace(/\n{3,}/g, "\n\n").trim();
	return { markdown: definitions.length ? `${body}\n\n${definitions.join("\n")}` : body, footnotes: order.length, pageMarkers };
}

// ---------------------------------------------------------------- helpers

async function need(zip: ZipArchive, path: string): Promise<string> {
	const text = await zip.text(path);
	if (text === null) throw new Error(`This EPUB is missing ${path}.`);
	return text;
}

function xml(text: string): Document {
	return new DOMParser().parseFromString(text, "application/xml");
}

/** XHTML parsed as XML (self-closing tags), else as HTML when it is not well-formed (named entities). */
function xhtml(text: string): Document {
	const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
	return doc.getElementsByTagName("parsererror").length > 0 ? new DOMParser().parseFromString(text, "text/html") : doc;
}

function byTag(root: Document | Element, local: string): Element[] {
	return Array.from(root.getElementsByTagName("*")).filter((el) => el.localName === local);
}

function children(el: Element, local: string): Element[] {
	return Array.from(el.children).filter((child) => child.localName === local);
}

function attr(el: Element | undefined, name: string): string {
	return el?.getAttribute(name) ?? "";
}

function ids(doc: Document | undefined): Map<string, Element> {
	const map = new Map<string, Element>();
	if (doc) for (const el of Array.from(doc.getElementsByTagName("*"))) if (el.id && !map.has(el.id)) map.set(el.id, el);
	return map;
}

function unwrap(el: Element): void {
	el.replaceWith(...Array.from(el.childNodes));
}

/** The first heading, else a short first paragraph (a styled title), else the document title. */
function headingOf(doc: Document): string | null {
	for (const tag of ["h1", "h2", "h3", "p", "title"]) {
		const text = clean(withoutTokens(byTag(doc, tag)[0]?.textContent ?? ""));
		if (text !== "" && (tag !== "p" || text.length <= 80) && !/\.x?html?$/.test(text)) return text;
	}
	return null;
}

function kindOf(file: string, text: string): string {
	if (/cover|tapa|portada/i.test(file)) return "cover";
	if (/\bISBN\b|©/.test(text)) return "copyright page";
	return countWords(text) === 0 ? "no text" : "short front or back matter";
}

/** Resolves `href` (possibly with a fragment) relative to the file at `base`. */
export function resolvePath(base: string, href: string): string {
	const [path = "", fragment] = href.split("#");
	const parts = base.split("/").slice(0, -1);
	for (const part of decodeURIComponent(path).split("/")) {
		if (part === "..") parts.pop();
		else if (part !== "." && part !== "") parts.push(part);
	}
	const joined = path === "" ? base : parts.join("/");
	return fragment === undefined ? joined : `${joined}#${fragment}`;
}

function splitHref(path: string): [string, string] {
	const at = path.indexOf("#");
	return at < 0 ? [path, ""] : [path.slice(0, at), path.slice(at + 1)];
}

function baseName(path: string): string {
	return path.split("/").pop() ?? path;
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function withoutTokens(text: string): string {
	return text.replace(/⟦(fn|pg)\d+⟧/g, " ");
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function ascii(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
