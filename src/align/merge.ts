/**
 * Merged units (ADR 0010): a side made of several blocks, whose map words
 * run across them in order. Pure. Owner: align module. DESIGN.md §4.3, §6.
 */
import { projectMarkdown } from "../text/inline";
import type { Block, LinkFit, PairUnit, ReconciledSide, Side, SideSig } from "../types";
import { sideOf } from "./map";
import { unitBlocks } from "./model";
import { reconcileSide } from "./reconcile";
import { sideSig } from "./signature";
import { wordsOf } from "./words";

/** Between the projections of a merged side's blocks; holds no word, so words simply follow each other. */
const BLOCK_JOIN = "\n\n";

/** The projection of one side of a unit: its blocks' projections, joined in order. */
export function sideProjection(blocks: readonly Block[]): string {
	return blocks.map((block) => projectMarkdown(block.body).text).join(BLOCK_JOIN);
}

/** One side of a unit's map fitted to the side's current Markdown, across all its blocks; null without a map or a block. */
export function fitUnitSide(unit: PairUnit, side: Side): ReconciledSide | null {
	const blocks = unitBlocks(unit, side);
	if (!unit.map || blocks.length === 0) return null;
	const text = sideProjection(blocks);
	return reconcileSide(sideOf(unit.map.links, side === "source" ? "src" : "tgt"), wordsOf(text), text);
}

/** What one block of a merged side holds of each link: its share as a stored side (null when none), and the side's fit. */
export interface BlockShare {
	stored: (SideSig | null)[];
	fits: LinkFit[];
}

/**
 * For a block of a merged side, each link's share of the block's words, as
 * if the block had a map of its own: the side is fitted across all its
 * blocks, then each link's range is cut to the block. A link crossing a
 * paragraph boundary has a share in both blocks. Null for a plain side.
 */
export function blockShare(unit: PairUnit, side: Side, block: Block): BlockShare | null {
	const blocks = unitBlocks(unit, side);
	const index = blocks.indexOf(block);
	if (!unit.map || blocks.length < 2 || index < 0) return null;
	const text = sideProjection(blocks);
	const words = wordsOf(text);
	const fitted = reconcileSide(sideOf(unit.map.links, side === "source" ? "src" : "tgt"), words, text);
	const start = wordsOf(sideProjection(blocks.slice(0, index))).length;
	const end = start + wordsOf(projectMarkdown(block.body).text).length;
	const stored = fitted.ranges.map((range) => {
		const from = Math.max(range.start, start);
		const to = Math.min(range.end, end);
		return to > from ? sideSig(words, { start: from, end: to }) : null;
	});
	return { stored, fits: [...fitted.fits] };
}
