/**
 * Scans a note into typed blocks with line ranges, ids and regions.
 * Pure: no `obsidian` runtime import. Owner: text module. DESIGN.md §5.1.
 */
import { MENARD_ID_RE, OWN_LINE_BLOCK_ID_RE, TRAILING_BLOCK_ID_RE, isMenardLine } from "../constants";
import type { Block, BlockKind, BlockRegion, NoteStructure, ParseOptions, UnitKind } from "../types";
import { projectMarkdown } from "./inline";

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const ATX_CLOSING_RE = /(?:^|[ \t]+)#+[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const QUOTE_PREFIX_RE = /^ {0,3}> ?/;
const CALLOUT_RE = /^ {0,3}>[ \t]*\[!([^\]\s]+)\][+-]?[ \t]*(.*)$/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** List items that may interrupt a paragraph (CommonMark): non-empty, ordered ones starting at 1. */
const INTERRUPTING_LIST_RE = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/;
const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const MATH_RE = /^ {0,3}\$\$/;
const EMBED_LINE_RE = /^ {0,3}!\[\[[^\]]*\]\][ \t]*$/;
const COMMENT_RE = /^ {0,3}%%/;
const TABLE_DELIMITER_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED_RE = /^(?: {4}|\t)/;
const LIST_CONTINUATION_RE = /^(?: {2}|\t)/;
const DEDENT_RE = /^(?: {1,4}|\t)/;
const HTML_COMMENT_RE = /^ {0,3}<!--/;
const HTML_RAW_RE = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i;
const HTML_BLOCK_TAGS =
	"address|article|aside|blockquote|center|details|dialog|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|li|main|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|tr|ul";
const HTML_BLOCK_RE = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, "i");
const HTML_LONE_TAG_RE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;
const HAS_WORD_RE = /[\p{L}\p{N}\p{M}]/u;

/** The heading the text starts after when textStartHeading is empty and autoTextStart is on. */
export const DEFAULT_TEXT_HEADING = "Text";
/**
 * What a metadata line is made of: links, wikilinks, embeds, autolinks, bare
 * URLs, inline code (Meta Bind `BUTTON[…]`), bare `BUTTON[…]`, comments and
 * block ids. A line with no word left once these are removed is metadata.
 */
const METADATA_TOKEN_RE = new RegExp(
	[
		/!?\[\[[^\]\n]*\]\]/.source,
		/!?\[[^\]\n]*\]\([^)\n]*\)/.source,
		/<[A-Za-z][\w+.-]*:[^<>\s]*>/.source,
		/\b[A-Za-z][\w+.-]*:\/\/\S+/.source,
		/`[^`\n]*`/.source,
		/\bBUTTON\[[^\]\n]*\]/.source,
		/%%.*?%%/.source,
		/\s\^[A-Za-z0-9-]+\s*$/.source,
	].join("|"),
	"g",
);
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

const UNIT_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["paragraph", "quote", "callout", "list", "table", "footnote", "heading"]);
const SENTENCE_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["paragraph", "quote", "callout"]);
/** Kinds that take an own-line id from a later `^id` line. */
const OWN_LINE_ID_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["paragraph", "quote", "callout", "list", "table"]);

/** A block as scanned, before its region, raw text and body are derived. */
interface Draft {
	kind: BlockKind;
	start: number;
	end: number;
	headingLevel?: number;
	headingText?: string;
	calloutType?: string;
	calloutTitle?: string;
	footnoteLabel?: string;
	id: string | null;
	idStyle: "trailing" | "own-line" | null;
	idLine: number | null;
}

/**
 * Splits `text` into blocks. Paragraphs end at blank lines (hard-wrapped
 * lines stay one paragraph). Recognizes frontmatter, headings, quotes,
 * callouts, lists, tables, footnote definitions (with 4-space continuation),
 * code fences, `$$` math, HTML blocks, embed-only lines, thematic breaks,
 * `%%` comment blocks and whole Menard lines. Strips block ids into
 * `id`/`idStyle`/`idLine`, and assigns each block its region.
 *
 * When `textStartHeading` is set but no heading matches it, the whole note
 * after the frontmatter is text. When it is empty and `autoTextStart` is on,
 * the text starts after a heading named "Text" if there is one, else after
 * the leading run of metadata blocks (see autoStartIndex). Footnote definitions are never skipped:
 * they belong to the note, not to the section they happen to follow.
 */
export function parseNote(text: string, options: ParseOptions): NoteStructure {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const frontmatter = findFrontmatter(lines);
	const scanner = new Scanner(lines);
	const drafts = scanner.scan(frontmatter === null ? 0 : frontmatter.end);
	const regions = assignRegions(drafts, options, lines);
	const blocks = drafts.map((draft, n) => finish(draft, lines, eol, regions[n] ?? "text"));
	return { eol, frontmatter, blocks, usedIds: collectIds(blocks, lines), lineCount: lines.length };
}

/** Blocks in the text region whose kind is a unit kind, in document order. */
export function textUnits(structure: NoteStructure): Block[] {
	return structure.blocks.filter((block) => block.region === "text" && UNIT_KINDS.has(block.kind));
}

/** True for paragraph, quote and callout: the kinds that carry sentence maps. */
export function isSentenceUnit(kind: UnitKind): boolean {
	return SENTENCE_KINDS.has(kind);
}

/** True when `line` closes a fence opened by `opener` (same character, at least as long, nothing after). */
export function closesFence(line: string, opener: string): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	const run = match?.[1];
	return run !== undefined && run.charAt(0) === opener.charAt(0) && run.length >= opener.length;
}

function findFrontmatter(lines: readonly string[]): { start: number; end: number } | null {
	if (lines[0] !== "---" && lines[0] !== "\uFEFF---") return null;
	for (let n = 1; n < lines.length; n++) {
		if (lines[n] === "---") return { start: 0, end: n + 1 };
	}
	return null;
}

function isBlank(line: string | undefined): boolean {
	return line === undefined || line.trim() === "";
}

/** Lines that end a paragraph (and any lazy continuation) without a blank line. */
function interrupts(line: string): boolean {
	return (
		isMenardLine(line) ||
		FENCE_RE.test(line) ||
		MATH_RE.test(line) ||
		ATX_RE.test(line) ||
		THEMATIC_RE.test(line) ||
		QUOTE_RE.test(line) ||
		FOOTNOTE_RE.test(line) ||
		INTERRUPTING_LIST_RE.test(line) ||
		HTML_COMMENT_RE.test(line) ||
		HTML_RAW_RE.test(line) ||
		HTML_BLOCK_RE.test(line)
	);
}

class Scanner {
	private readonly drafts: Draft[] = [];

	constructor(private readonly lines: readonly string[]) {}

	scan(from: number): Draft[] {
		let n = from;
		while (n < this.lines.length) {
			const line = this.lines[n] ?? "";
			n = isBlank(line) ? n + 1 : this.block(n, line);
		}
		return this.drafts;
	}

	private line(n: number): string {
		return this.lines[n] ?? "";
	}

	private add(kind: BlockKind, start: number, end: number, extra: Partial<Draft> = {}): number {
		this.drafts.push({ kind, start, end, id: null, idStyle: null, idLine: null, ...extra });
		return end;
	}

	/** Scans the block starting at line `n` and returns the line after it. */
	private block(n: number, line: string): number {
		if (isMenardLine(line)) return this.add("menard", n, n + 1);
		const fence = FENCE_RE.exec(line)?.[1];
		if (fence !== undefined) return this.add("verbatim", n, this.fenceEnd(n, fence));
		if (MATH_RE.test(line)) return this.add("verbatim", n, this.mathEnd(n, line));
		const atx = ATX_RE.exec(line);
		if (atx !== null) return this.add("heading", n, n + 1, { headingLevel: atx[1]?.length ?? 1, headingText: atxText(atx[2] ?? "") });
		if (THEMATIC_RE.test(line)) return this.add("verbatim", n, n + 1);
		if (QUOTE_RE.test(line)) return this.quote(n, line);
		const footnote = FOOTNOTE_RE.exec(line);
		if (footnote !== null) return this.add("footnote", n, this.footnoteEnd(n), { footnoteLabel: footnote[1] ?? "" });
		if (line.includes("|") && this.isTableDelimiter(n + 1)) return this.withOwnLineId(this.add("table", n, this.tableEnd(n)));
		if (LIST_RE.test(line)) return this.withOwnLineId(this.add("list", n, this.listEnd(n)));
		const html = this.htmlEnd(n, line);
		if (html !== null) return this.add("verbatim", n, html);
		const ownId = ownLineIdOf(line);
		if (ownId !== undefined) return this.ownLineId(n, ownId);
		if (COMMENT_RE.test(line)) {
			const comment = this.commentEnd(n, line);
			if (comment !== null) return this.add("verbatim", n, comment);
		}
		if (EMBED_LINE_RE.test(line)) return this.add("verbatim", n, n + 1);
		if (INDENTED_RE.test(line)) return this.add("verbatim", n, this.indentedEnd(n));
		return this.paragraph(n);
	}

	private fenceEnd(n: number, opener: string): number {
		for (let m = n + 1; m < this.lines.length; m++) {
			if (closesFence(this.line(m), opener)) return m + 1;
		}
		return this.lines.length;
	}

	private mathEnd(n: number, line: string): number {
		const rest = line.trim().slice(2);
		if (rest.includes("$$")) return n + 1;
		for (let m = n + 1; m < this.lines.length; m++) {
			if (this.line(m).includes("$$")) return m + 1;
		}
		return this.lines.length;
	}

	private quote(n: number, line: string): number {
		const end = this.quoteEnd(n);
		const draft: Draft = { kind: "quote", start: n, end, id: null, idStyle: null, idLine: null };
		setTrailingId(draft, this.line(end - 1), end - 1);
		const callout = CALLOUT_RE.exec(end - n === 1 ? (stripTrailingId([line])[0] ?? "") : line);
		if (callout !== null) Object.assign(draft, { kind: "callout", calloutType: callout[1] ?? "", calloutTitle: (callout[2] ?? "").trim() });
		this.drafts.push(draft);
		return this.withOwnLineId(end);
	}

	private quoteEnd(n: number): number {
		let m = n + 1;
		let lazyAllowed = !isBlank(this.line(n).replace(QUOTE_PREFIX_RE, ""));
		while (m < this.lines.length) {
			const line = this.line(m);
			if (QUOTE_RE.test(line)) {
				lazyAllowed = !isBlank(line.replace(QUOTE_PREFIX_RE, ""));
			} else if (isBlank(line) || !lazyAllowed || interrupts(line) || ownLineIdOf(line) !== undefined) {
				break;
			}
			m++;
		}
		return m;
	}

	private footnoteEnd(n: number): number {
		let m = n + 1;
		while (m < this.lines.length) {
			const line = this.line(m);
			if (isBlank(line)) {
				const next = this.nextNonBlank(m);
				if (next === null || !INDENTED_RE.test(this.line(next))) break;
				m = next;
			} else if (INDENTED_RE.test(line) || (!isBlank(this.line(m - 1)) && !interrupts(line))) {
				m++;
			} else {
				break;
			}
		}
		return m;
	}

	private isTableDelimiter(n: number): boolean {
		const line = this.lines[n];
		return line !== undefined && line.includes("|") && line.includes("-") && TABLE_DELIMITER_RE.test(line);
	}

	private tableEnd(n: number): number {
		let m = n + 2;
		while (m < this.lines.length && !isBlank(this.line(m)) && !interrupts(this.line(m))) m++;
		return m;
	}

	private listEnd(n: number): number {
		let m = n + 1;
		while (m < this.lines.length) {
			const line = this.line(m);
			if (isBlank(line)) {
				const next = this.nextNonBlank(m);
				if (next === null) break;
				const following = this.line(next);
				if (!(LIST_RE.test(following) && !THEMATIC_RE.test(following)) && !LIST_CONTINUATION_RE.test(following)) break;
				m = next;
			} else if (
				(LIST_RE.test(line) && !THEMATIC_RE.test(line)) ||
				LIST_CONTINUATION_RE.test(line) ||
				(!isBlank(this.line(m - 1)) && !interrupts(line))
			) {
				m++;
			} else {
				break;
			}
		}
		return m;
	}

	private htmlEnd(n: number, line: string): number | null {
		if (HTML_COMMENT_RE.test(line)) return this.untilLineContaining(n, "-->");
		const raw = HTML_RAW_RE.exec(line)?.[1];
		if (raw !== undefined) return this.untilLineContaining(n, `</${raw.toLowerCase()}>`);
		if (!HTML_BLOCK_RE.test(line) && !HTML_LONE_TAG_RE.test(line)) return null;
		let m = n + 1;
		while (m < this.lines.length && !isBlank(this.line(m))) m++;
		return m;
	}

	private untilLineContaining(n: number, token: string): number {
		for (let m = n; m < this.lines.length; m++) {
			if (this.line(m).toLowerCase().includes(token)) return m + 1;
		}
		return this.lines.length;
	}

	/**
	 * A `%%` comment block, or null when the line is a paragraph opening with an inline comment.
	 * A Menard-looking line inside it is the user's text and does not close it (#35).
	 */
	private commentEnd(n: number, line: string): number | null {
		const body = line.trimStart().slice(2);
		const close = body.indexOf("%%");
		if (close !== -1) return body.slice(close + 2).trim() === "" ? n + 1 : null;
		for (let m = n + 1; m < this.lines.length; m++) {
			if (this.line(m).includes("%%") && !isMenardLine(this.line(m))) return m + 1;
		}
		return this.lines.length;
	}

	private indentedEnd(n: number): number {
		let m = n + 1;
		while (m < this.lines.length) {
			if (INDENTED_RE.test(this.line(m))) {
				m++;
				continue;
			}
			const next = isBlank(this.line(m)) ? this.nextNonBlank(m) : null;
			if (next === null || !INDENTED_RE.test(this.line(next))) break;
			m = next;
		}
		return m;
	}

	private paragraph(n: number): number {
		let m = n + 1;
		while (m < this.lines.length && !isBlank(this.line(m))) {
			const line = this.line(m);
			const setext = SETEXT_RE.exec(line)?.[1];
			if (setext !== undefined) {
				const text = this.lines.slice(n, m).map((l) => l.trim()).join(" ");
				return this.add("heading", n, m + 1, { headingLevel: setext.startsWith("=") ? 1 : 2, headingText: text });
			}
			if (interrupts(line)) break;
			m++;
		}
		const draft: Draft = { kind: "paragraph", start: n, end: m, id: null, idStyle: null, idLine: null };
		const ownLine = m - n > 1 ? ownLineIdOf(this.line(m - 1)) : undefined;
		if (ownLine !== undefined) {
			Object.assign(draft, { end: m - 1, id: ownLine, idStyle: "own-line", idLine: m - 1 });
		} else {
			setTrailingId(draft, this.line(m - 1), m - 1);
		}
		const body = paragraphLines(this.lines, draft).join("\n");
		if (!HAS_WORD_RE.test(projectMarkdown(body).text)) draft.kind = "verbatim";
		this.drafts.push(draft);
		return m;
	}

	/** A standalone `^id` line attaches to the unit above it across blank lines, or stands as verbatim. */
	private ownLineId(n: number, id: string): number {
		const previous = this.drafts[this.drafts.length - 1];
		if (previous !== undefined && previous.id === null && OWN_LINE_ID_KINDS.has(previous.kind) && previous.end < n) {
			Object.assign(previous, { id, idStyle: "own-line", idLine: n });
			return n + 1;
		}
		return this.add("verbatim", n, n + 1);
	}

	/** Claims a `^id` line that follows the block ending at `end` after at least one blank line. */
	private withOwnLineId(end: number): number {
		const draft = this.drafts[this.drafts.length - 1];
		const next = this.nextNonBlank(end - 1);
		if (draft === undefined || draft.id !== null || next === null || next === end) return end;
		const id = ownLineIdOf(this.line(next));
		if (id === undefined) return end;
		Object.assign(draft, { id, idStyle: "own-line", idLine: next });
		return next + 1;
	}

	/** The first non-blank line after `m`, or null. */
	private nextNonBlank(m: number): number | null {
		for (let k = m + 1; k < this.lines.length; k++) {
			if (!isBlank(this.line(k))) return k;
		}
		return null;
	}
}

/** The id of a line holding only `^id`, or undefined. */
function ownLineIdOf(line: string): string | undefined {
	return OWN_LINE_BLOCK_ID_RE.exec(line.trimEnd())?.[1];
}

function atxText(rest: string): string {
	return rest.replace(ATX_CLOSING_RE, "").trim();
}

/** The id of a line ending in ` ^id` (trailing whitespace allowed), or undefined. */
function trailingIdOf(line: string): string | undefined {
	return TRAILING_BLOCK_ID_RE.exec(line.trimEnd())?.[1];
}

function setTrailingId(draft: Draft, line: string, n: number): void {
	const id = trailingIdOf(line);
	if (id !== undefined) Object.assign(draft, { id, idStyle: "trailing", idLine: n });
}

/** A paragraph's lines with a trailing id removed. */
function paragraphLines(lines: readonly string[], draft: Draft): string[] {
	const own = lines.slice(draft.start, draft.end);
	return draft.idStyle === "trailing" ? stripTrailingId(own) : own;
}

function stripTrailingId(lines: string[]): string[] {
	const last = lines[lines.length - 1];
	if (last === undefined) return lines;
	const match = TRAILING_BLOCK_ID_RE.exec(last.trimEnd());
	return match === null ? lines : [...lines.slice(0, -1), last.slice(0, match.index)];
}

function assignRegions(drafts: readonly Draft[], options: ParseOptions, lines: readonly string[]): BlockRegion[] {
	const start = options.textStartHeading.trim().toLowerCase();
	const skip = new Set(options.skipHeadings.map((heading) => heading.trim().toLowerCase()).filter((h) => h !== ""));
	const startIndex =
		start !== ""
			? drafts.findIndex((d) => d.kind === "heading" && d.headingText?.toLowerCase() === start)
			: options.autoTextStart === true
				? autoStartIndex(drafts, lines)
				: -1;
	let skipLevel: number | null = null;
	return drafts.map((draft, n) => {
		if (n <= startIndex) return "preamble";
		if (draft.kind === "heading") {
			const level = draft.headingLevel ?? 1;
			if (skipLevel !== null && level <= skipLevel) skipLevel = null;
			if (skipLevel === null && skip.has(draft.headingText?.toLowerCase() ?? "")) skipLevel = level;
		}
		return skipLevel !== null && draft.kind !== "footnote" ? "skipped" : "text";
	});
}

/**
 * The index of the last preamble block when no start heading is set (#26):
 * a heading named "Text" (any level, case-insensitive) when the note has
 * one; otherwise the last of the leading blocks that hold only metadata
 * (embed lines, comments, HTML and other verbatim blocks, and paragraphs or
 * lists whose every line is links, embeds, URLs, inline code or `BUTTON[…]`
 * once list markers and symbols are ignored). Headings, quotes, callouts,
 * tables, footnotes and any paragraph with a word of prose end the run.
 * Returns -1 (the whole note is text) when a block before that point
 * already carries a Menard id, so notes translated under the old default
 * keep their units.
 */
function autoStartIndex(drafts: readonly Draft[], lines: readonly string[]): number {
	const wanted = DEFAULT_TEXT_HEADING.toLowerCase();
	let index = drafts.findIndex((d) => d.kind === "heading" && d.headingText?.toLowerCase() === wanted);
	if (index < 0) {
		index = -1;
		while (index + 1 < drafts.length && isMetadataBlock(drafts[index + 1] as Draft, lines)) index++;
	}
	const translated = drafts.slice(0, index + 1).some((d) => d.id !== null && MENARD_ID_RE.test(d.id));
	return translated ? -1 : index;
}

function isMetadataBlock(draft: Draft, lines: readonly string[]): boolean {
	if (draft.kind === "verbatim") return true;
	if (draft.kind !== "paragraph" && draft.kind !== "list") return false;
	return lines.slice(draft.start, draft.end).every((line) => isBlank(line) || isMetadataLine(line.replace(LIST_MARKER_RE, "")));
}

/** True for a line that is only links, embeds, URLs, code or buttons, with at least one of them. */
export function isMetadataLine(line: string): boolean {
	const rest = line.replace(METADATA_TOKEN_RE, "");
	return rest !== line && !HAS_WORD_RE.test(rest);
}

function finish(draft: Draft, lines: readonly string[], eol: string, region: BlockRegion): Block {
	const own = lines.slice(draft.start, draft.end);
	const rawLines = draft.idStyle === "trailing" ? stripTrailingId(own) : own;
	const block: Block = {
		kind: draft.kind,
		region,
		lines: { start: draft.start, end: draft.end },
		raw: rawLines.join(eol),
		body: bodyOf(draft, rawLines),
		id: draft.id,
		idStyle: draft.idStyle,
		idLine: draft.idLine,
	};
	if (draft.headingLevel !== undefined) block.headingLevel = draft.headingLevel;
	if (draft.calloutType !== undefined) block.calloutType = draft.calloutType;
	if (draft.calloutTitle !== undefined) block.calloutTitle = draft.calloutTitle;
	if (draft.footnoteLabel !== undefined) block.footnoteLabel = draft.footnoteLabel;
	return block;
}

function bodyOf(draft: Draft, rawLines: readonly string[]): string {
	switch (draft.kind) {
		case "heading":
			return draft.headingText ?? "";
		case "quote":
			return rawLines.map(unquote).join("\n");
		case "callout":
			return rawLines.slice(1).map(unquote).join("\n");
		case "footnote": {
			const [first = "", ...rest] = rawLines;
			const head = (FOOTNOTE_RE.exec(first)?.[2] ?? "").trimStart();
			return [head, ...rest.map((line) => line.replace(DEDENT_RE, ""))].join("\n");
		}
		default:
			return rawLines.join("\n");
	}
}

function unquote(line: string): string {
	return QUOTE_RE.test(line) ? line.replace(QUOTE_PREFIX_RE, "") : line;
}

/** Every block id in the note: blocks' own ids plus ids on any line of a non-verbatim block (list items, mid-paragraph). */
function collectIds(blocks: readonly Block[], lines: readonly string[]): Set<string> {
	const ids = new Set<string>();
	for (const block of blocks) {
		if (block.id !== null) ids.add(block.id);
		if (block.kind === "menard") continue;
		if (block.kind === "verbatim") {
			const own = ownLineIdOf(block.raw);
			if (own !== undefined) ids.add(own);
			continue;
		}
		for (let n = block.lines.start; n < block.lines.end; n++) {
			const line = lines[n] ?? "";
			const id = trailingIdOf(line) ?? ownLineIdOf(line.trimStart());
			if (id !== undefined) ids.add(id);
		}
	}
	return ids;
}
