/**
 * The initial translation note for Translate note. Pure.
 * Owner: jobs module. DESIGN.md §7.1.
 */
import { serializeMenardLine } from "../align/map";
import { FM } from "../constants";
import type { NoteStructure, UnitKey } from "../types";

export interface SkeletonInput {
	source: NoteStructure;
	/** Unit key for each text-region unit block, by index in source.blocks (footnotes use fn: keys). */
	keys: ReadonlyMap<number, UnitKey>;
	/** Translated heading text, by index in source.blocks. */
	headings: ReadonlyMap<number, string>;
	/** Frontmatter entries, already formatted as YAML scalar values. */
	frontmatter: Readonly<Record<string, string>>;
}

/**
 * Frontmatter, then the text region in source order: translated headings,
 * verbatim blocks copied, one `%%menard:1 <key> translate%%` marker per unit;
 * footnote markers last, in source order. Skipped sections and the preamble
 * are omitted. One blank line between blocks; the source note's EOL.
 */
export function buildSkeleton(input: SkeletonInput): string {
	const { source, keys, headings } = input;
	const eol = source.eol;
	const body: string[] = [];
	const footnotes: string[] = [];
	source.blocks.forEach((block, index) => {
		if (block.region !== "text") return;
		if (block.kind === "heading") {
			body.push(`${"#".repeat(block.headingLevel ?? 1)} ${headings.get(index) ?? block.body}`);
		} else if (block.kind === "verbatim") {
			body.push(block.raw);
		} else if (block.kind !== "menard") {
			const key = keys.get(index);
			if (key === undefined) return;
			const marker = serializeMenardLine({ kind: "marker", key, task: "translate" });
			(block.kind === "footnote" ? footnotes : body).push(marker);
		}
	});
	return frontmatterBlock(input.frontmatter, eol) + [...body, ...footnotes].join(eol + eol) + eol;
}

/** `---`, one `key: value` line per entry, `---`, each line ending in `eol`. */
export function frontmatterBlock(entries: Readonly<Record<string, string>>, eol: string): string {
	const lines = Object.entries(entries).map(([key, value]) => `${key}: ${value}`);
	return ["---", ...lines, "---", ""].join(eol);
}

/**
 * The frontmatter of a new translation note: the pair link and languages,
 * then the user's newNoteProperties, each value written as a YAML scalar.
 */
export function newNoteFrontmatter(
	sourceLink: string,
	languages: { source: string; target: string },
	properties: Readonly<Record<string, string>>,
): Record<string, string> {
	const entries: Record<string, string> = {
		[FM.source]: sourceLink,
		[FM.sourceLanguage]: languages.source,
		[FM.targetLanguage]: languages.target,
		...properties,
	};
	return Object.fromEntries(Object.entries(entries).map(([key, value]): [string, string] => [key, yamlScalar(value)]));
}

/**
 * A string as a YAML scalar: plain when that is unambiguous, otherwise
 * double-quoted (JSON strings are valid YAML double-quoted scalars).
 */
export function yamlScalar(value: string): string {
	const plain = /^[A-Za-z0-9_][\w .,/()@'-]*$/.test(value) && !/\s$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
	return plain ? value : JSON.stringify(value);
}
