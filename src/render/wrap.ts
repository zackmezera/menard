/**
 * Wraps character ranges of a projection in sentence spans by splitting
 * text nodes; never uses innerHTML or surroundContents, never moves an
 * element. Owner: render module. DESIGN.md §9.1.
 */
import { linkCharRanges } from "../align/cuts";
import { sideOf } from "../align/map";
import { blockShare } from "../align/merge";
import { reconcileSide } from "../align/reconcile";
import { wordsOf } from "../align/words";
import { ATTR, CLS } from "../constants";
import type { Block, CharRange, PairUnit, ReconciledSide, Side } from "../types";
import { FOOTNOTE_REF_SELECTOR, isBlockElement, projectElement, type DomProjection } from "./dom-projection";

/**
 * For each range i, splits the text nodes it covers at its boundaries and
 * wraps every covered piece in `span.menard-s[data-menard-link=attr(i)]`
 * with `classes(i)`. A range crossing <em> or <a> yields several spans
 * sharing one attribute. A footnote-ref <sup> directly after a range's last
 * piece receives the same attribute. Empty ranges create nothing.
 * Whitespace at a range's edges stays outside its spans.
 */
export function wrapRanges(
	projection: DomProjection,
	ranges: readonly CharRange[],
	attr: (index: number) => string,
	classes: (index: number) => readonly string[],
): void {
	const { text } = projection;
	// The unwrapped remainder of each piece: ranges are processed in text order,
	// so everything before `start` has already been wrapped or passed over.
	const rest: { node: Text | null; start: number }[] = projection.pieces.map((piece) => ({ node: piece.node, start: piece.start }));
	const order = ranges.map((range, index) => ({ range, index })).sort((a, b) => a.range.start - b.range.start);

	for (const { range, index } of order) {
		let start = Math.max(0, range.start);
		let end = Math.min(text.length, range.end);
		while (start < end && isSpace(text[start])) start++;
		while (end > start && isSpace(text[end - 1])) end--;
		if (start >= end) continue;

		let last: HTMLSpanElement | null = null;
		for (const piece of rest) {
			if (piece.node === null) continue;
			const length = projectedLength(piece.node);
			if (piece.start >= end) break;
			if (piece.start + length <= start) continue;

			let node = piece.node;
			if (start > piece.start) {
				node = node.splitText(rawOffset(node, start - piece.start));
				piece.node = node;
				piece.start = start;
			}
			const coveredEnd = Math.min(end, piece.start + projectedLength(node));
			if (coveredEnd < piece.start + projectedLength(node)) {
				piece.node = node.splitText(rawOffset(node, coveredEnd - piece.start));
				piece.start = coveredEnd;
			} else {
				piece.node = null;
			}
			last = wrapNode(node, attr(index), classes(index));
		}
		if (last) tagFootnoteRef(last, attr(index));
	}
}

/**
 * Projects a unit element, fits the map's `side` to its words, and wraps
 * each link as `<key>.<n>`. Shared by the post-processor and the gloss so
 * both carry identical spans. Returns null when the unit has no map.
 *
 * `block` is the block the element renders. For one block of a merged
 * unit's side (ADR 0010) only that block's share of each link is wrapped,
 * under the same `<key>.<n>`, so a link crossing a paragraph boundary is
 * one link in both paragraphs.
 */
export function wrapUnit(unitEl: HTMLElement, unit: PairUnit, side: Side, block?: Block): ReconciledSide | null {
	const map = unit.map;
	if (!map) return null;
	const projection = projectElement(unitEl);
	const words = wordsOf(projection.text);
	const share = block === undefined ? null : blockShare(unit, side, block);
	const own = reconcileSide(share?.stored ?? sideOf(map.links, side === "source" ? "src" : "tgt"), words, projection.text);
	// A share's links fit its block by construction; how the merged side fits the text as a whole is what to show.
	const fitted: ReconciledSide = share === null ? own : { ...own, fits: own.fits.map((fit, i) => (fit === "exact" ? (share.fits[i] ?? fit) : fit)) };
	if (fitted.fits.every((fit) => fit === "lost" || fit === "empty")) return fitted;

	const ranges = linkCharRanges(projection.text, words, fitted.ranges);
	wrapRanges(
		projection,
		ranges,
		(i) => `${unit.key}.${i + 1}`,
		(i) => {
			const link = map.links[i];
			const cls: string[] = [];
			if (link && (side === "source" ? link.tgt : link.src) === null) cls.push(CLS.flagged);
			if (link?.loose) cls.push(CLS.loose);
			if (fitted.fits[i] === "approximate") cls.push(CLS.approximate);
			return cls;
		},
	);
	return fitted;
}

/** Removes wrapping that `wrapUnit` added inside `root`, leaving the text in place. */
export function unwrapAll(root: HTMLElement): void {
	for (const span of Array.from(root.querySelectorAll(`span.${CLS.sentence}[${ATTR.link}]`))) {
		const parent = span.parentNode;
		if (!parent) continue;
		while (span.firstChild) parent.insertBefore(span.firstChild, span);
		parent.removeChild(span);
	}
	for (const tagged of Array.from(root.querySelectorAll(`[${ATTR.link}]`))) tagged.removeAttribute(ATTR.link);
}

function wrapNode(node: Text, link: string, classes: readonly string[]): HTMLSpanElement {
	const parent = node.parentNode as Node;
	// createSpan appends to `parent`; insertBefore then places the new span.
	const span = parent.createSpan({ cls: [CLS.sentence, ...classes], attr: { [ATTR.link]: link } });
	parent.insertBefore(span, node);
	span.appendChild(node);
	return span;
}

/** Gives a footnote ref the link's attribute when it directly follows the link's last span. */
function tagFootnoteRef(lastSpan: HTMLSpanElement, link: string): void {
	let node: Node = lastSpan;
	for (;;) {
		let next = node.nextSibling;
		while (next && next.nodeType === 3 && (next as Text).data.length === 0) next = next.nextSibling;
		if (next) {
			if (next.nodeType === 1 && (next as Element).matches(FOOTNOTE_REF_SELECTOR)) (next as Element).setAttribute(ATTR.link, link);
			return;
		}
		const parent = node.parentElement;
		if (!parent || isBlockElement(parent)) return;
		node = parent;
	}
}

function isSpace(char: string | undefined): boolean {
	return char !== undefined && /\s/u.test(char);
}

function projectedLength(node: Text): number {
	return node.data.normalize("NFC").length;
}

/**
 * The offset in `node.data` where `projected` NFC characters of it end:
 * the first raw offset whose prefix normalizes to that many characters,
 * moved forward until the split keeps every composed character whole
 * (combining marks, conjoining Hangul jamo).
 */
function rawOffset(node: Text, projected: number): number {
	const data = node.data;
	const whole = data.normalize("NFC");
	if (whole === data) return projected;
	// A prefix's NFC length never shrinks as the prefix grows, so bisect.
	let low = 0;
	let high = data.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (data.slice(0, mid).normalize("NFC").length < projected) low = mid + 1;
		else high = mid;
	}
	let raw = low;
	while (raw < data.length && data.slice(0, raw).normalize("NFC") + data.slice(raw).normalize("NFC") !== whole) raw++;
	return raw;
}
