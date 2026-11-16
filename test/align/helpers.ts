/**
 * Literal builders for text-module structures, so align tests never call
 * text-module functions (the two modules are built concurrently).
 */
import { sideSig } from "../../src/align/signature";
import { wordsOf } from "../../src/align/words";
import type { Block, BlockKind, BlockRegion, NoteStructure, SideSig } from "../../src/types";

export interface BlockSpec {
	kind: BlockKind;
	/** First line, 0-based. */
	line: number;
	raw: string;
	region?: BlockRegion;
	body?: string;
	id?: string;
	idStyle?: "trailing" | "own-line";
	/** Own-line id line; defaults to two lines after the block for own-line ids. */
	idLine?: number;
	footnoteLabel?: string;
	headingLevel?: number;
}

/** A Block literal whose line range is derived from the number of lines in `raw`. */
export function block(spec: BlockSpec): Block {
	const lineCount = spec.raw.split("\n").length;
	const end = spec.line + lineCount;
	const idStyle = spec.id === undefined ? null : (spec.idStyle ?? "trailing");
	let idLine: number | null = null;
	if (idStyle === "trailing") idLine = end - 1;
	if (idStyle === "own-line") idLine = spec.idLine ?? end + 1;
	return {
		kind: spec.kind,
		region: spec.region ?? "text",
		lines: { start: spec.line, end },
		raw: spec.raw,
		body: spec.body ?? spec.raw,
		id: spec.id ?? null,
		idStyle,
		idLine,
		...(spec.footnoteLabel === undefined ? {} : { footnoteLabel: spec.footnoteLabel }),
		...(spec.headingLevel === undefined ? {} : { headingLevel: spec.headingLevel }),
	};
}

/** A NoteStructure literal around the given blocks. */
export function note(blocks: readonly Block[]): NoteStructure {
	const usedIds = new Set(blocks.flatMap((b) => (b.id === null ? [] : [b.id])));
	const lineCount = blocks.reduce((max, b) => Math.max(max, b.lines.end, (b.idLine ?? -1) + 1), 0);
	return { eol: "\n", frontmatter: null, blocks, usedIds, lineCount };
}

/** The signature of a whole sentence, as a map writer would store it. */
export function sigOf(sentence: string): SideSig {
	const words = wordsOf(sentence);
	return sideSig(words, { start: 0, end: words.length });
}

/** "count.hash" of a whole sentence, as written in a map. */
export function sigText(sentence: string): string {
	const sig = sigOf(sentence);
	return `${sig.count}.${sig.hash}`;
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
