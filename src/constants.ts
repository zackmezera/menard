/**
 * Names and patterns shared across modules: the on-disk grammar's fixed
 * tokens, frontmatter keys, and the DOM/CSS contract between the renderer,
 * the reader and styles.css. Design-owned; see docs/DESIGN.md §4 and §9.
 */

/** Frontmatter keys that link a pair (ADR 0003) and record its languages. */
export const FM = {
	/** On the source note: wikilink to the translation note. */
	translation: "translation",
	/** On the translation note: wikilink to the source note. */
	source: "source",
	/** On the translation note: BCP 47 code of the source language. */
	sourceLanguage: "sourceLanguage",
	/** On the translation note: BCP 47 code of the translation's language. */
	targetLanguage: "targetLanguage",
} as const;

/** Version tag written into every Menard line. Bump only with a new ADR. */
export const MAP_VERSION = 1;

/** Opening token of every Menard-owned comment line: `%%menard:1 …%%`. */
export const MENARD_LINE_PREFIX = `%%menard:${MAP_VERSION} `;

const MENARD_LINE_RE = /^%%menard:1 [^%\n]+%%$/;

/**
 * True for a whole line that Menard owns: a sentence map or a pending-task
 * marker, with no leading or trailing text, not even whitespace (#35). The
 * one predicate every module uses, so a line is owned everywhere or nowhere.
 * Where a line stands (code, a user's `%%` block) is `text/blocks.ts`'s call;
 * parsing the body is `align/map.ts`'s.
 */
export function isMenardLine(line: string): boolean {
	return MENARD_LINE_RE.test(line);
}

/** Ids that Menard allocates. Other block ids belong to the user. */
export const MENARD_ID_RE = /^p\d+$/;

/** A trailing block id at the end of a line, as Obsidian parses it. */
export const TRAILING_BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)$/;

/** A line that holds only a block id (structured blocks). */
export const OWN_LINE_BLOCK_ID_RE = /^\^([A-Za-z0-9-]+)$/;

/** Data attributes the renderer writes and the reader queries. */
export const ATTR = {
	/** On a section's unit element: the unit key, e.g. "p12". */
	unit: "data-menard-unit",
	/** On a unit element: how well the stored map fits the current text. */
	fit: "data-menard-fit",
	/** On every sentence fragment span: "<unitKey>.<linkIndex>", 1-based, e.g. "p12.3". */
	link: "data-menard-link",
	/** On a section that holds only a Menard line (hidden by CSS). */
	menardSection: "data-menard-line",
	/** On a leaf's container while it takes part in a facing session. */
	role: "data-menard-role",
	/** On a container rendered offscreen by Menard; the post-processor skips it. */
	offscreen: "data-menard-offscreen",
} as const;

/** CSS classes; styles.css styles exactly these. */
export const CLS = {
	/** Every wrapped sentence fragment. */
	sentence: "menard-s",
	/** Fragments of the current link (reading cursor). */
	current: "menard-current",
	/** Fragments of the current link's partner in the other pane. */
	partner: "menard-partner",
	/** Fragments under the pointer, and their partner. */
	hover: "menard-hover",
	/** A link whose other side is empty: a flagged span. */
	flagged: "menard-flagged",
	/** A link marked loose by the aligner. */
	loose: "menard-loose",
	/** A link whose position was estimated after the text changed. */
	approximate: "menard-approx",
	/** A unit highlighted as a whole (no usable sentence map). */
	unitCurrent: "menard-unit-current",
	unitPartner: "menard-unit-partner",
	/** The stacked-view translation slot under the current link. */
	gloss: "menard-gloss",
	/** The gloss while reveal mode hides it. */
	concealed: "menard-concealed",
	/** The floating hover card in stacked view. */
	ghost: "menard-ghost",
	/** On a leaf's container in a facing session. */
	facing: "menard-facing",
	/** On a leaf's container in stacked view. */
	stacked: "menard-stacked",
	/** On each window body while the "Fade other sentences" setting is on. */
	dimInactive: "menard-dim-inactive",
} as const;

/** Placeholder brackets used when protecting verbatim tokens in prompts. */
export const PLACEHOLDER_OPEN = "⟦"; // ⟦
export const PLACEHOLDER_CLOSE = "⟧"; // ⟧
