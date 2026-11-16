/**
 * #33: Align writes the source note's ids and then the translation note's
 * ids and markers. A failure between the two writes must leave a state
 * that a rerun completes to exactly what an uninterrupted run writes.
 */
import { describe, expect, it } from "vitest";
import { MenardError } from "../../src/errors";
import { runAlign } from "../../src/jobs/align";
import { callKind, createHarness, fakeClaude } from "./harness";
import type { Harness } from "./harness";
import { ALIGN_SOURCE, ALIGN_TARGET } from "./fixtures";

const SOURCE_PATH = "Collections/Texts/@x.md";
const TARGET_PATH = "Collections/Texts/@x (EN).md";

/** Three source paragraphs; the translation splits the second (1-2) and merges nothing else. */
const SPLIT_SOURCE = "Primer párrafo del ensayo.\n\nSegundo párrafo, largo. Tiene dos frases.\n\nTercer párrafo del ensayo.\n";
const SPLIT_TARGET = "First paragraph of the essay.\n\nSecond paragraph, long.\n\nIt has two sentences.\n\nThird paragraph of the essay.\n";
const SPLIT_PAIRING = { groups: [{ src: [1], tgt: [1] }, { src: [2], tgt: [2, 3] }, { src: [3], tgt: [4] }] };
/** Two source paragraphs merged into one (2-1). */
const MERGE_SOURCE = "Primer párrafo del ensayo.\n\nSegundo párrafo.\n\nTercero, unido al segundo.\n\nCuarto párrafo del ensayo.\n";
const MERGE_TARGET = "First paragraph of the essay.\n\nSecond paragraph, and the third joined to it.\n\nFourth paragraph of the essay.\n";
const MERGE_PAIRING = { groups: [{ src: [1], tgt: [1] }, { src: [2, 3], tgt: [2] }, { src: [4], tgt: [3] }] };

function harness(pairing: unknown): Harness {
	const h = createHarness();
	h.backend.handler = (request) => (callKind(request) === "pairing" && pairing !== null ? pairing : fakeClaude(request));
	return h;
}

async function uninterrupted(source: string, target: string, pairing: unknown): Promise<[string, string]> {
	const h = harness(pairing);
	const s = h.vault.add(SOURCE_PATH, source);
	const t = h.vault.add(TARGET_PATH, target);
	await runAlign(h.deps, s, t, new AbortController());
	return [h.vault.text(s), h.vault.text(t)];
}

/** Fails the `nth` note write of the first run (1 = source ids, 2 = translation ids and markers), then reruns. */
async function interrupted(source: string, target: string, pairing: unknown, nth: number): Promise<[string, string]> {
	const h = harness(pairing);
	const s = h.vault.add(SOURCE_PATH, source);
	const t = h.vault.add(TARGET_PATH, target);
	const insert = h.deps.writer.insert.bind(h.deps.writer);
	let writes = 0;
	h.deps.writer.insert = async (file, compute) => {
		if (++writes === nth) throw new MenardError("write-conflict", "Injected failure.");
		return insert(file, compute);
	};
	await expect(runAlign(h.deps, s, t, new AbortController())).rejects.toThrow("Injected failure.");
	h.deps.writer.insert = insert;
	await runAlign(h.deps, s, t, new AbortController());
	return [h.vault.text(s), h.vault.text(t)];
}

describe("Align's two note writes (#33)", () => {
	const cases = [
		["plain pairs", ALIGN_SOURCE, ALIGN_TARGET, null],
		["a split paragraph (1-2)", SPLIT_SOURCE, SPLIT_TARGET, SPLIT_PAIRING],
		["merged paragraphs (2-1)", MERGE_SOURCE, MERGE_TARGET, MERGE_PAIRING],
	] as const;
	for (const [name, source, target, pairing] of cases) {
		for (const nth of [1, 2]) {
			it(`converges after a failed write ${nth} with ${name}`, async () => {
				const expected = await uninterrupted(source, target, pairing);
				expect(expected[1]).toContain("%%menard:1 ");
				expect(await interrupted(source, target, pairing, nth)).toEqual(expected);
			});
		}
	}
});
