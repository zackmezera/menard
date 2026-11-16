/**
 * Markdown-side projection: the text a reader sees for some inline Markdown.
 * Must agree, word for word, with render/dom-projection.ts (DESIGN.md §5.2).
 * Pure. Owner: text module.
 */
import type { Projection } from "../types";

const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const WHITESPACE_RE = /\s/;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const FOOTNOTE_REF_RE = /^\[\^[^\]\s]+\]/;
const AUTOLINK_RE = /^<((?:https?|mailto|ftp|obsidian|zotero):[^\s<>]*)>/i;
const HTML_TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/;
const ENTITY_RE = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]+);/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	AMP: "&",
	lt: "<",
	LT: "<",
	gt: ">",
	GT: ">",
	quot: '"',
	QUOT: '"',
	apos: "'",
	nbsp: "\u00a0",
	laquo: "\u00ab",
	raquo: "\u00bb",
	ldquo: "\u201c",
	rdquo: "\u201d",
	lsquo: "\u2018",
	rsquo: "\u2019",
	iexcl: "\u00a1",
	iquest: "\u00bf",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	ordm: "\u00ba",
	ordf: "\u00aa",
	szlig: "\u00df",
	deg: "\u00b0",
	sect: "\u00a7",
	...accentedEntities(),
};
/** Characters that never start a normalization chunk: combining marks, Hangul medial vowels and finals. */
const CONTINUATION_RE = /[\p{M}\u1160-\u11ff]/u;

/** Characters emitted so far, each with the input index it came from (-1: removed emphasis marker). */
interface Sink {
	chars: string[];
	from: number[];
}

/** A run of `*`, `_`, `~~` or `==` that may open or close emphasis, as emitted into the sink. */
interface DelimiterRun {
	ch: string;
	/** Sink indices [left, right) of the characters not yet used by a match. */
	left: number;
	right: number;
	length: number;
	canOpen: boolean;
	canClose: boolean;
}

/**
 * Projects inline Markdown to visible text, NFC-normalized, with an offset
 * table back into `markdown`. Drops footnote refs, inline `%%…%%`, inline
 * code and math, embeds, HTML tags and emphasis markers; keeps link display
 * text (`[[a|b]]` → "b", `[[a]]` → "a", `[[a#h]]` → "a > h", `[t](u)` → "t");
 * resolves backslash escapes; keeps "\n" for line breaks.
 */
export function projectMarkdown(markdown: string): Projection {
	const sink: Sink = { chars: [], from: [] };
	scan(markdown, 0, markdown.length, sink);
	return normalize(sink);
}

function emit(sink: Sink, text: string, from: number): void {
	for (const ch of text) {
		sink.chars.push(ch);
		sink.from.push(from);
	}
}

function emitRange(sink: Sink, md: string, start: number, end: number): void {
	for (let i = start; i < end; i++) {
		sink.chars.push(md.charAt(i));
		sink.from.push(i);
	}
}

/** Projects md[start, end) into `sink`. */
function scan(md: string, start: number, end: number, sink: Sink): void {
	const runs: DelimiterRun[] = [];
	let i = start;
	while (i < end) {
		const run = delimiterRun(md, i, end);
		if (run !== null) {
			runs.push({ ...run, left: sink.chars.length, right: sink.chars.length + run.length });
			emitRange(sink, md, i, i + run.length);
			i += run.length;
			continue;
		}
		const next = consume(md, i, end, sink);
		if (next === null) {
			emit(sink, md.charAt(i), i);
			i++;
		} else {
			i = next;
		}
	}
	removeMatchedDelimiters(runs, sink);
}

/** Handles the construct starting at `i` and returns the index after it, or null for a plain character. */
function consume(md: string, i: number, end: number, sink: Sink): number | null {
	const next = md.charAt(i + 1);
	switch (md.charAt(i)) {
		case "\\":
			if (next === "\n") return i + 1;
			if (i + 1 < end && ASCII_PUNCT_RE.test(next)) {
				emit(sink, next, i + 1);
				return i + 2;
			}
			return null;
		case "`":
			return skipCodeSpan(md, i, end);
		case "%":
			return next === "%" ? (closeAfter(md, "%%", i + 2, end) ?? end) : null;
		case "$":
			return skipMath(md, i, end);
		case "!":
			return next === "[" ? skipEmbed(md, i, end) : null;
		case "^":
			return next === "[" ? skipInlineFootnote(md, i, end) : null;
		case "[":
			return consumeBracket(md, i, end, sink);
		case "<":
			return consumeAngle(md, i, end, sink);
		case "&":
			return consumeEntity(md, i, end, sink);
		default:
			return null;
	}
}

/** Index just past the first `token` at or after `from` and within `end`, or null. */
function closeAfter(md: string, token: string, from: number, end: number): number | null {
	const at = md.indexOf(token, from);
	return at === -1 || at + token.length > end ? null : at + token.length;
}

function runLength(md: string, i: number, end: number, ch: string): number {
	let n = 0;
	while (i + n < end && md.charAt(i + n) === ch) n++;
	return n;
}

function skipCodeSpan(md: string, i: number, end: number): number | null {
	const n = runLength(md, i, end, "`");
	let j = i + n;
	while (j < end) {
		const at = md.indexOf("`", j);
		if (at === -1 || at >= end) return null;
		const m = runLength(md, at, end, "`");
		if (m === n) return at + m;
		j = at + m;
	}
	return null;
}

/** `$$…$$`, or `$…$` whose content neither starts nor ends with a space and whose close is not followed by a digit. */
function skipMath(md: string, i: number, end: number): number | null {
	if (md.charAt(i + 1) === "$") return closeAfter(md, "$$", i + 2, end);
	if (i + 1 >= end || WHITESPACE_RE.test(md.charAt(i + 1))) return null;
	for (let j = i + 1; j < end; j++) {
		const c = md.charAt(j);
		if (c === "\\") {
			j++;
		} else if (c === "$") {
			const closes = !WHITESPACE_RE.test(md.charAt(j - 1)) && !/\d/.test(md.charAt(j + 1));
			return closes ? j + 1 : null;
		}
	}
	return null;
}

function skipEmbed(md: string, i: number, end: number): number | null {
	if (md.charAt(i + 2) === "[") return closeAfter(md, "]]", i + 3, end);
	return parseInlineLink(md, i + 1, end)?.end ?? null;
}

function skipInlineFootnote(md: string, i: number, end: number): number | null {
	const close = matchingBracket(md, i + 1, end);
	return close === null ? null : close + 1;
}

function consumeBracket(md: string, i: number, end: number, sink: Sink): number | null {
	if (md.charAt(i + 1) === "[") return consumeWikilink(md, i, end, sink);
	const footnote = FOOTNOTE_REF_RE.exec(md.slice(i, end));
	if (footnote) return i + footnote[0].length;
	const link = parseInlineLink(md, i, end);
	if (link === null) return null;
	scan(md, link.textStart, link.textEnd, sink);
	return link.end;
}

/** `[[target]]`, `[[target|display]]`, `[[note#heading]]` → their display text. */
function consumeWikilink(md: string, i: number, end: number, sink: Sink): number | null {
	const close = closeAfter(md, "]]", i + 2, end);
	if (close === null) return null;
	const innerEnd = close - 2;
	const pipe = md.indexOf("|", i + 2);
	if (pipe !== -1 && pipe < innerEnd) {
		emitRange(sink, md, pipe + 1, innerEnd);
		return close;
	}
	let partStart = i + 2;
	let first = true;
	for (let j = partStart; j <= innerEnd; j++) {
		if (j < innerEnd && md.charAt(j) !== "#") continue;
		if (j > partStart) {
			if (!first) emit(sink, " > ", partStart - 1);
			emitRange(sink, md, partStart, j);
			first = false;
		}
		partStart = j + 1;
	}
	return close;
}

/** Index of the `]` matching the `[` at `open`, honoring nesting and escapes. */
function matchingBracket(md: string, open: number, end: number): number | null {
	let depth = 0;
	for (let j = open; j < end; j++) {
		const c = md.charAt(j);
		if (c === "\\") j++;
		else if (c === "[") depth++;
		else if (c === "]" && --depth === 0) return j;
	}
	return null;
}

/** `[text](destination "title")`: the text range and the end of the whole link. */
function parseInlineLink(md: string, open: number, end: number): { textStart: number; textEnd: number; end: number } | null {
	const close = matchingBracket(md, open, end);
	if (close === null || md.charAt(close + 1) !== "(") return null;
	let depth = 0;
	let inAngle = false;
	for (let j = close + 1; j < end; j++) {
		const c = md.charAt(j);
		if (c === "\\") j++;
		else if (c === "\n" && md.charAt(j + 1) === "\n") return null;
		else if (c === "<" && j === close + 2) inAngle = true;
		else if (inAngle) inAngle = c !== ">";
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return { textStart: open + 1, textEnd: close, end: j + 1 };
	}
	return null;
}

/** HTML comments and tags are dropped (`<br>` becomes "\n"); autolinks keep their URL. */
function consumeAngle(md: string, i: number, end: number, sink: Sink): number | null {
	if (md.startsWith("<!--", i)) return closeAfter(md, "-->", i + 4, end) ?? end;
	const rest = md.slice(i, end);
	const autolink = AUTOLINK_RE.exec(rest);
	if (autolink?.[1] !== undefined) {
		emitRange(sink, md, i + 1, i + 1 + autolink[1].length);
		return i + autolink[0].length;
	}
	const tag = HTML_TAG_RE.exec(rest);
	if (tag === null) return null;
	if (tag[2]?.toLowerCase() === "br") emit(sink, "\n", i);
	return i + tag[0].length;
}

function consumeEntity(md: string, i: number, end: number, sink: Sink): number | null {
	const match = ENTITY_RE.exec(md.slice(i, end));
	const name = match?.[1];
	if (match === null || name === undefined) return null;
	let decoded: string | undefined;
	if (name.startsWith("#")) {
		const hex = name[1] === "x" || name[1] === "X";
		const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		decoded = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
	} else {
		decoded = NAMED_ENTITIES[name];
	}
	if (decoded === undefined) return null;
	emit(sink, decoded, i);
	return i + match[0].length;
}

/**
 * A run of emphasis (`*`, `_`), strikethrough (`~~`) or highlight (`==`)
 * characters that can open or close by CommonMark's flanking rules, or null.
 * `snake_case`, `5 * 3` and `a == b` give null and stay as written.
 */
function delimiterRun(md: string, i: number, end: number): Omit<DelimiterRun, "left" | "right"> | null {
	const ch = md.charAt(i);
	if (ch !== "*" && ch !== "_" && ch !== "~" && ch !== "=") return null;
	const length = runLength(md, i, end, ch);
	if ((ch === "~" || ch === "=") && length !== 2) return null;
	const before = i > 0 ? md.charAt(i - 1) : " ";
	const after = i + length < md.length ? md.charAt(i + length) : " ";
	const beforeSpace = WHITESPACE_RE.test(before);
	const afterSpace = WHITESPACE_RE.test(after);
	const beforePunct = PUNCT_RE.test(before);
	const afterPunct = PUNCT_RE.test(after);
	const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
	const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
	const canOpen = ch === "_" ? left && (!right || beforePunct) : left;
	const canClose = ch === "_" ? right && (!left || afterPunct) : right;
	return canOpen || canClose ? { ch, length, canOpen, canClose } : null;
}

/**
 * Pairs delimiter runs as CommonMark's "process emphasis" does and removes
 * the characters each match uses. Unmatched markers stay visible, as they do
 * in reading view: `2*3` projects to "2*3", not "23".
 */
function removeMatchedDelimiters(runs: readonly DelimiterRun[], sink: Sink): void {
	const openers: DelimiterRun[] = [];
	for (const closer of runs) {
		while (closer.canClose && closer.right > closer.left) {
			const k = findOpener(openers, closer);
			const opener = openers[k];
			if (opener === undefined) break;
			const both = Math.min(opener.right - opener.left, closer.right - closer.left);
			const use = closer.ch === "~" || closer.ch === "=" ? 2 : Math.min(both, 2);
			opener.right -= use;
			for (let n = 0; n < use; n++) {
				sink.from[opener.right + n] = -1;
				sink.from[closer.left + n] = -1;
			}
			closer.left += use;
			openers.splice(opener.right > opener.left ? k + 1 : k);
		}
		if (closer.canOpen && closer.right > closer.left) openers.push(closer);
	}
}

/** Index in `openers` of the nearest run that `closer` can close, or -1. */
function findOpener(openers: readonly DelimiterRun[], closer: DelimiterRun): number {
	for (let k = openers.length - 1; k >= 0; k--) {
		const opener = openers[k];
		if (opener === undefined || opener.ch !== closer.ch) continue;
		const sum = opener.length + closer.length;
		const ruleOfThree = (opener.canClose || closer.canOpen) && sum % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0);
		if (!ruleOfThree) return k;
	}
	return -1;
}

/** The Latin-1 accented letters (`&eacute;`, `&Ntilde;`…), built from base letter plus combining mark. */
function accentedEntities(): Record<string, string> {
	const marks: readonly [string, string, string][] = [
		["acute", "\u0301", "aeiouyAEIOUY"],
		["grave", "\u0300", "aeiouAEIOU"],
		["circ", "\u0302", "aeiouAEIOU"],
		["uml", "\u0308", "aeiouyAEIOUY"],
		["tilde", "\u0303", "anoANO"],
		["cedil", "\u0327", "cC"],
		["ring", "\u030a", "aA"],
	];
	const entities: Record<string, string> = {};
	for (const [suffix, mark, letters] of marks) {
		for (const letter of letters) entities[letter + suffix] = (letter + mark).normalize("NFC");
	}
	return entities;
}

/** NFC-normalizes chunk by chunk so that every output character keeps an input index. */
function normalize(sink: Sink): Projection {
	const kept = sink.from.flatMap((from, n) => (from === -1 ? [] : [n]));
	const chars = kept.map((n) => sink.chars[n] ?? "");
	const froms = kept.map((n) => sink.from[n] ?? 0);
	const out: string[] = [];
	const map: number[] = [];
	let k = 0;
	while (k < chars.length) {
		let j = k + 1;
		while (j < chars.length && CONTINUATION_RE.test(chars[j] ?? "")) j++;
		const chunk = chars.slice(k, j).join("").normalize("NFC");
		const from = froms[k] ?? 0;
		for (let c = 0; c < chunk.length; c++) {
			out.push(chunk.charAt(c));
			map.push(from);
		}
		k = j;
	}
	return { text: out.join(""), toInput: Int32Array.from(map) };
}
