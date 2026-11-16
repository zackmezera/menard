/**
 * PDF text layer → lines → Markdown, from pdf.js text items (which carry
 * positions and font sizes). Drops running heads and folios, rejoins lines,
 * dehyphenates, starts a paragraph at an indent, a wide gap or after a short
 * closing line; labels display titles, set-off headings, inset block
 * quotations and epigraphs, and moves only foot-of-page small type to Notes.
 * The pure part takes plain items; `readPdfPages` wraps pdf.js (Obsidian's
 * bundled copy through `loadPdfJs()` in the app). Owner: import module.
 * DESIGN.md §16.
 *
 * ponytail: heuristics tuned on two scanned books; a two-column layout or a
 * page of verse comes out as run-on paragraphs, and section headings come
 * from layout alone (the PDF outline is not consulted).
 */
import { reduce } from "./pages";
import type { PageOpening } from "./pages";

/** The fields of a pdf.js TextItem Menard reads. */
export interface PdfItem {
	str: string;
	/** [a, b, c, d, x, y]: d is the font height, (x, y) the baseline origin. */
	transform: number[];
	width: number;
}

export interface PdfPage {
	/** 1-based page index in the PDF. */
	index: number;
	/** The page label the PDF declares (often the printed number), or null. */
	label: string | null;
	items: PdfItem[];
}

export interface Line {
	text: string;
	x: number;
	y: number;
	width: number;
	size: number;
}

/** pdf.js's document proxy, as far as Menard uses it. */
export interface PdfJsDocument {
	numPages: number;
	getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
	getPageLabels(): Promise<string[] | null>;
}

/** Reads pages `from`..`to` (1-based, inclusive, clamped) as plain items. */
export async function readPdfPages(doc: PdfJsDocument, from = 1, to = doc.numPages): Promise<PdfPage[]> {
	const labels = await doc.getPageLabels().catch(() => null);
	const pages: PdfPage[] = [];
	for (let n = Math.max(1, from); n <= Math.min(to, doc.numPages); n++) {
		const content = await (await doc.getPage(n)).getTextContent();
		const items = content.items.filter((item): item is PdfItem => typeof (item as PdfItem).str === "string");
		pages.push({ index: n, label: labels?.[n - 1] ?? null, items });
	}
	return pages;
}

/** Groups a page's items into lines, top to bottom, by baseline. */
export function pageLines(items: readonly PdfItem[]): Line[] {
	const pieces = items
		.filter((item) => item.str.trim() !== "")
		.map((item) => ({ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width, size: Math.abs(item.transform[3] ?? 0) || 10 }))
		.sort((a, b) => b.y - a.y || a.x - b.x);
	const lines: { pieces: typeof pieces }[] = [];
	for (const piece of pieces) {
		const line = lines.find((candidate) => Math.abs(candidate.pieces[0]!.y - piece.y) < piece.size * 0.5);
		if (line) line.pieces.push(piece);
		else lines.push({ pieces: [piece] });
	}
	return lines
		.map(({ pieces: row }) => {
			row.sort((a, b) => a.x - b.x);
			let text = "";
			let end = row[0]!.x;
			for (const piece of row) {
				const gap = piece.x - end > piece.size * 0.15;
				if (text !== "" && gap && !/\s$/.test(text) && !/^\s/.test(piece.str)) text += " ";
				text += piece.str;
				end = Math.max(end, piece.x + piece.width);
			}
			const sizes = row.map((piece) => piece.size).sort((a, b) => a - b);
			return { text: text.replace(/\s+/g, " ").trim(), x: row[0]!.x, y: row[0]!.y, width: end - row[0]!.x, size: sizes[sizes.length >> 1]! };
		})
		.sort((a, b) => b.y - a.y);
}


/**
 * Removes running heads and folios: a short top or bottom line that is a bare
 * number, a short text with a number at one end, or a text that recurs at the
 * top (or bottom) of another page in the set. Display type (a chapter's
 * number and title) is never furniture.
 */
export function stripFurniture(pages: readonly Line[][]): Line[][] {
	const counts = (pick: (lines: Line[]) => Line[]): Map<string, number> => {
		const map = new Map<string, number>();
		for (const lines of pages) for (const line of pick(lines)) map.set(reduce(line.text), (map.get(reduce(line.text)) ?? 0) + 1);
		return map;
	};
	const tops = counts((lines) => lines.slice(0, 2));
	const bottoms = counts((lines) => lines.slice(-2));
	return pages.map((lines) => {
		const body = [...lines];
		const width = typicalWidth(body);
		const size = median(body.map((line) => line.size));
		// A head with a page number at one end is furniture only at the top: at the bottom it may be a footnote.
		const furniture = (line: Line | undefined, seen: Map<string, number>, top: boolean): boolean => {
			if (!line || line.width > width * 0.75 || line.size >= size * DISPLAY) return false;
			const key = reduce(line.text);
			if (/^[\divxlc]+$/i.test(line.text.replace(/[\s.\-–—]/g, ""))) return true;
			if (key !== "" && (seen.get(key) ?? 0) >= 2) return true;
			return top && /^\d+\s+\D{2,40}$|^\D{2,40}\s+\d+$/.test(line.text);
		};
		for (let i = 0; i < 2 && furniture(body[0], tops, true); i++) body.shift();
		for (let i = 0; i < 2 && furniture(body[body.length - 1], bottoms, false); i++) body.pop();
		return body;
	});
}

/** Type this much larger than the page's body is display type: a chapter number and title. */
const DISPLAY = 1.4;

function typicalWidth(lines: readonly Line[]): number {
	const widths = lines.map((line) => line.width).sort((a, b) => a - b);
	return widths[Math.floor(widths.length * 0.8)] ?? 0;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? 0;
}

export interface PdfTextOptions {
	/** Printed page label for a 1-based PDF page index. */
	label: (page: PdfPage) => string;
}

/** What a line is: display title, section heading, block quotation, epigraph, body text, or footnote. */
type Kind = "title" | "heading" | "quote" | "epigraph" | "body" | "note";

/** A page's measure: body size, leading, left margin and right edge. */
interface Measure {
	size: number;
	leading: number;
	left: number;
	right: number;
}

function measure(lines: readonly Line[]): Measure {
	const size = median(lines.map((line) => line.size));
	const leading = median(lines.slice(1).map((line, i) => lines[i]!.y - line.y).filter((gap) => gap > 0 && gap < size * 3));
	// The left margin is the leftmost x that several lines share; the right edge is where the lines that start there end.
	const xs = lines.map((line) => line.x);
	const shared = xs.filter((x) => xs.filter((other) => Math.abs(other - x) <= 2).length >= 3);
	const left = Math.min(...(shared.length > 0 ? shared : xs));
	const flush = lines.filter((line) => Math.abs(line.x - left) <= 2);
	const right = Math.max(...(flush.length > 0 ? flush : lines).map((line) => line.x + line.width));
	return { size, leading, left, right };
}

/**
 * Labels each line of a page. Display type at the top is the title; a
 * short line or two (not spanning the measure) set off by space
 * above and below, in larger type (or body type with more space), is a
 * heading; small type at the foot of the page after a gap is a note; a run
 * of lines inset on both sides is a block quotation, or an epigraph before
 * any body text.
 */
function classify(lines: readonly Line[], m: Measure, bodySeen: boolean): Kind[] {
	const kinds: Kind[] = lines.map(() => "body");
	const em = m.size || 10;
	const gapAbove = (i: number): number => (i === 0 ? Infinity : lines[i - 1]!.y - lines[i]!.y);
	let i = 0;
	while (i < lines.length && lines[i]!.size >= m.size * DISPLAY) kinds[i++] = "title";
	const top = i;
	// Footnotes: a trailing run of small type below a gap.
	let foot = lines.length;
	while (foot > top && lines[foot - 1]!.size < m.size * 0.9) foot--;
	if (foot < lines.length && foot > top && gapAbove(foot) > m.leading * 1.3) for (let j = foot; j < lines.length; j++) kinds[j] = "note";
	else foot = lines.length;
	// Headings: one or two short lines with space above and below.
	for (let j = top; j < foot; j++) {
		for (const count of [1, 2]) {
			const run = lines.slice(j, j + count);
			if (run.length < count || j + count > foot) continue;
			const big = run.every((line) => line.size >= m.size * 1.06);
			const short = run.every((line) => (line.x - m.left > em * 0.8 || line.x + line.width < m.right - em * 0.8) && !/[.,;]$/.test(line.text));
			const linked = count === 1 || gapAbove(j + 1) < m.leading * 1.6;
			const above = gapAbove(j);
			const below = j + count < lines.length ? gapAbove(j + count) : Infinity;
			const room = big ? m.leading * 1.4 : m.leading * 1.8;
			if (short && linked && above > room && below > room && (big || (count === 1 && /^\p{Lu}/u.test(run[0]!.text)))) {
				for (let k = j; k < j + count; k++) kinds[k] = "heading";
				j += count - 1;
				break;
			}
		}
	}
	// Quotations: runs of lines inset at both margins (the last line of a run may end short anyway).
	const inset = (line: Line): boolean => line.x - m.left >= em * 0.8 && line.x + line.width <= m.right - em * 0.8;
	for (let j = top; j < foot; ) {
		if (kinds[j] !== "body" || !inset(lines[j]!)) {
			j++;
			continue;
		}
		let end = j;
		while (end < foot && kinds[end] === "body" && inset(lines[end]!)) end++;
		const run = lines.slice(j, end);
		const small = median(run.map((line) => line.size)) < m.size * 0.95;
		if (run.length >= 2 || small) for (let k = j; k < end; k++) kinds[k] = bodySeen ? "quote" : "epigraph";
		j = end;
	}
	if (!bodySeen) {
		// Epigraphs exist only before the first body line or heading.
		const first = kinds.findIndex((kind) => kind === "body" || kind === "heading");
		if (first >= 0) for (let k = first; k < foot; k++) if (kinds[k] === "epigraph") kinds[k] = "quote";
	}
	return kinds;
}

/**
 * The Markdown body for a run of pages: paragraphs with a `%%p. N%%` marker
 * where each page starts, `#` for a chapter's display title, `##` for
 * section headings, `> ` for block quotations (joined across lines and
 * pages), and true footnotes gathered under `## Notes` at the end.
 */
export function pdfToMarkdown(pages: readonly PdfPage[], options: PdfTextOptions): string {
	const linesByPage = stripFurniture(pages.map((page) => pageLines(page.items)));
	const blocks: string[] = [];
	const notes: string[] = [];
	let current = "";
	let kind: Kind | null = null;
	const flush = (): void => {
		const text = current.trim();
		if (text !== "" && kind !== null) blocks.push(kind === "title" ? `# ${text}` : kind === "heading" ? `## ${text}` : kind === "quote" ? `> ${text}` : text);
		current = "";
	};
	const append = (text: string): void => {
		if (/[-­]$/.test(current) && /^\p{Ll}/u.test(text)) current = current.replace(/[-­]$/, "") + text;
		else if (kind === "title" && /^\d+$/.test(current)) current = `${current}. ${text}`;
		else current = current === "" ? text : `${current} ${text}`;
	};
	let previous: Line | null = null;
	let previousEnds = false;
	let bodySeen = false;
	linesByPage.forEach((lines, p) => {
		const page = pages[p]!;
		const marker = `%%p. ${options.label(page)}%%`;
		const m = measure(lines);
		const kinds = classify(lines, m, bodySeen);
		const em = m.size || 10;
		let marked = false;
		lines.forEach((line, i) => {
			const next = kinds[i]!;
			if (next === "note") return;
			const gap = i > 0 && m.leading > 0 && lines[i - 1]!.y - line.y > m.leading * 1.6;
			const indent = line.x - m.left > em * 0.8 && line.x - m.left < em * 8;
			const moved = previous !== null && Math.abs(line.x - previous.x) > em;
			const breaks =
				previous === null ||
				next !== kind ||
				(next === "heading" && gap) ||
				(next === "body" && (indent || gap || previousEnds)) ||
				(next === "epigraph" && (moved || gap || previousEnds)) ||
				(next === "quote" && (gap || (previousEnds && line.x - previous.x > em * 0.8)));
			if (breaks) flush();
			kind = next;
			let text = line.text;
			if (!marked && next !== "title") {
				marked = true;
				if (next === "heading") blocks.push(marker);
				else if (/[-­]$/.test(current) && /^\p{Ll}/u.test(text)) {
					// The page starts mid-word: keep the word whole, mark the page after it.
					const [word = "", ...rest] = text.split(" ");
					text = [word, marker, ...rest].join(" ");
				} else append(marker);
			}
			append(text);
			previous = line;
			previousEnds = line.x + line.width < m.right - em * 2 && /[.?!:"”’)»]$/.test(line.text);
			if (next === "body" || next === "heading") bodySeen = true;
		});
		const small = lines.filter((_, i) => kinds[i] === "note");
		if (small.length > 0) notes.push(`${marker} ${small.map((line) => line.text).join(" ")}`);
	});
	flush();
	return [...blocks, ...(notes.length > 0 ? ["## Notes", ...notes] : [])].join("\n\n");
}

/** Each page's first `count` letters and its letter total, for placing its marker in another text. */
export function pageOpenings(pages: readonly PdfPage[], label: (page: PdfPage) => string, count = 60): PageOpening[] {
	const linesByPage = stripFurniture(pages.map((page) => pageLines(page.items)));
	return pages.map((page, p) => {
		const lines = linesByPage[p]!;
		const size = median(lines.map((line) => line.size));
		// A chapter's display title is not where its text starts.
		const all = reduce(lines.filter((line) => line.size < size * DISPLAY).map((line) => line.text).join(" "));
		return { label: label(page), opening: all.slice(0, count), letters: all.length };
	});
}
