/**
 * Block-id allocation and placement. Pure. Owner: text module. DESIGN.md §4.2.
 */
import type { Block, BlockKind, Insert, NoteStructure } from "../types";
import { lineEnd, lineStarts } from "./edits";

/** `p<n>` with n small enough to count past exactly; a longer number is still reserved, just not counted from. */
const MENARD_ID_NUMBER_RE = /^p(\d{1,15})$/;
const BLOCK_ID_RE = /^[A-Za-z0-9-]+$/;
const OWN_LINE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["quote", "callout", "list", "table"]);

/**
 * Returns `count` new ids `p<n>`, starting above the highest `p<n>` in use
 * and skipping any id in `structure.usedIds` or `reserved`.
 */
export function allocateIds(structure: NoteStructure, count: number, reserved?: ReadonlySet<string>): string[] {
	const taken = new Set([...structure.usedIds, ...(reserved ?? [])]);
	let n = 0;
	for (const id of taken) {
		const digits = MENARD_ID_NUMBER_RE.exec(id)?.[1];
		if (digits !== undefined) n = Math.max(n, Number(digits));
	}
	const ids: string[] = [];
	while (ids.length < count) {
		n++;
		const id = `p${n}`;
		if (!taken.has(id)) ids.push(id);
	}
	return ids;
}

/**
 * Insertions that give each block its id: ` ^id` appended to a paragraph's
 * last line (after any trailing inline comment), or `^id` on its own line
 * after a quote, callout, list or table with a blank line before and after.
 * Blocks that already have an id are an error. Uses the note's EOL.
 */
export function idInserts(text: string, structure: NoteStructure, assignments: readonly { block: Block; id: string }[]): Insert[] {
	const starts = lineStarts(text);
	const lineCount = starts.length - 1;
	const isBlankLine = (n: number): boolean => text.slice(starts[n], lineEnd(text, starts, n)).trim() === "";
	const seen = new Set<Block>();
	const inserts: Insert[] = [];
	for (const { block, id } of assignments) {
		if (block.id !== null) throw new Error(`Block at line ${block.lines.start + 1} already has the id ^${block.id}`);
		if (seen.has(block)) throw new Error(`Block at line ${block.lines.start + 1} is assigned two ids`);
		if (!BLOCK_ID_RE.test(id)) throw new Error(`"${id}" is not a valid block id`);
		seen.add(block);
		const last = block.lines.end - 1;
		const at = lineEnd(text, starts, last);
		if (block.kind === "paragraph") {
			inserts.push({ at, text: ` ^${id}` });
		} else if (OWN_LINE_KINDS.has(block.kind)) {
			const eol = structure.eol;
			const followedByText = last + 1 < lineCount && !isBlankLine(last + 1);
			inserts.push({ at, text: `${eol}${eol}^${id}${followedByText ? eol : ""}` });
		} else {
			throw new Error(`A ${block.kind} block cannot carry a block id`);
		}
	}
	return inserts.sort((a, b) => a.at - b.at);
}

