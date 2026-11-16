/**
 * Validates model output against its input before anything is written.
 * Pure. Owner: llm module. DESIGN.md §10.4.
 *
 * Error strings are fed back to the model on retry ("Your previous answer
 * was rejected: …"), so each one names the exact problem, without a final
 * period.
 */
import type {
	AlignGroup,
	AlignOutput,
	AlignUnitInput,
	OutlineInput,
	OutlineOutput,
	PairingGroup,
	PairingInput,
	PairingOutput,
	PlainOutput,
	PlainUnitInput,
	Protected,
	TranslateGroup,
	TranslateOutput,
	TranslateUnitInput,
	Validation,
} from "../types";
import { placeholdersIn, wikilinksIn } from "./protect";

/** Target-to-source length ratios outside this range only warn. */
export const LENGTH_RATIO_RANGE = { min: 0.4, max: 2.5 } as const;

/**
 * Coverage (src numbers flatten to 1..N, each group consecutive, only one
 * leading or trailing addition group with src []), placeholders (exact
 * multiset), wikilinks (exact multiset), forbidden content (`%%`, blank
 * lines, a trailing `^id`, a leading `#`, `>`, `-` or `|` that the source
 * line does not have), and a length ratio warning outside [0.4, 2.5].
 */
export function validateTranslate(input: TranslateUnitInput, tokens: Protected["tokens"], output: unknown): Validation<TranslateOutput> {
	const errors: string[] = [];
	const root = asRecord(output);
	const rawGroups = root ? root.groups : undefined;
	if (!root || !Array.isArray(rawGroups) || rawGroups.length === 0) {
		return fail(['the answer must be an object with a non-empty "groups" array']);
	}

	const groups: TranslateGroup[] = [];
	rawGroups.forEach((raw: unknown, index) => {
		const group = asRecord(raw);
		const src = group ? integers(group.src) : null;
		if (!group || src === null || typeof group.markdown !== "string") {
			errors.push(`group ${index + 1} must have "src" (an array of integers) and "markdown" (a string)`);
			return;
		}
		groups.push({ src, markdown: group.markdown.trim() });
	});
	if (errors.length > 0) return fail(errors);

	const additions = groups.map((group, index) => (group.src.length === 0 ? index : -1)).filter((index) => index >= 0);
	if (additions.length > 1) errors.push(`only one group may have an empty "src", found ${additions.length}`);
	for (const index of additions) {
		if (index !== 0 && index !== groups.length - 1) errors.push(`group ${index + 1} has an empty "src" but is neither the first nor the last group`);
	}
	if (additions.length === groups.length) errors.push("every group has an empty \"src\"");
	errors.push(...coverageErrors(groups.map((group) => group.src), input.sentences.length, "sentence"));

	groups.forEach((group, index) => {
		if (group.markdown === "") errors.push(`group ${index + 1} has no text`);
		const source = group.src.map((n) => input.sentences[n - 1] ?? "").join(" ");
		errors.push(...forbiddenContent(group.markdown, source, `group ${index + 1}`));
	});

	const sourceText = input.sentences.join(" ");
	const targetText = groups.map((group) => group.markdown).join(" ");
	errors.push(...multisetErrors("placeholder", placeholdersIn(sourceText), placeholdersIn(targetText), tokens));
	errors.push(...multisetErrors("wikilink", wikilinksIn(sourceText), wikilinksIn(targetText)));

	let calloutTitle: string | undefined;
	if (input.calloutTitle !== undefined) {
		calloutTitle = typeof root.calloutTitle === "string" ? root.calloutTitle.trim() : undefined;
		if (calloutTitle === undefined || calloutTitle === "") errors.push('"calloutTitle" is missing or empty');
		else if (calloutTitle.includes("\n")) errors.push('"calloutTitle" must be a single line');
		else {
			// The title stays on the callout's header line, so only content checks apply, not line-start markers.
			if (calloutTitle.includes("%%")) errors.push('"calloutTitle" contains %%');
			if (hasStrayBracket(calloutTitle)) errors.push(STRAY_BRACKET_ERROR('"calloutTitle"'));
			if (TRAILING_ID_RE.test(calloutTitle)) errors.push('"calloutTitle" ends with a block id');
			errors.push(...multisetErrors("placeholder in calloutTitle", placeholdersIn(input.calloutTitle), placeholdersIn(calloutTitle), tokens));
			errors.push(...multisetErrors("wikilink in calloutTitle", wikilinksIn(input.calloutTitle), wikilinksIn(calloutTitle)));
		}
	}

	if (errors.length > 0) return fail(errors);
	const warnings = lengthWarning(sourceText, targetText);
	return { ok: true, value: calloutTitle === undefined ? { groups } : { groups, calloutTitle }, warnings };
}

/** Both sides covered exactly once, each group contiguous, groups monotone, no group empty on both sides. */
export function validateAlign(input: AlignUnitInput, output: unknown): Validation<AlignOutput> {
	const errors: string[] = [];
	const root = asRecord(output);
	const rawGroups = root ? root.groups : undefined;
	if (!root || !Array.isArray(rawGroups) || rawGroups.length === 0) {
		return fail(['the answer must be an object with a non-empty "groups" array']);
	}

	const groups: AlignGroup[] = [];
	rawGroups.forEach((raw: unknown, index) => {
		const group = asRecord(raw);
		const src = group ? integers(group.src) : null;
		const tgt = group ? integers(group.tgt) : null;
		if (!group || src === null || tgt === null || typeof group.loose !== "boolean") {
			errors.push(`group ${index + 1} must have "src" and "tgt" (arrays of integers) and "loose" (a boolean)`);
			return;
		}
		if (src.length === 0 && tgt.length === 0) errors.push(`group ${index + 1} is empty on both sides`);
		groups.push({ src, tgt, loose: group.loose });
	});
	if (errors.length > 0) return fail(errors);

	errors.push(...coverageErrors(groups.map((group) => group.src), input.source.length, "source sentence"));
	errors.push(...coverageErrors(groups.map((group) => group.tgt), input.target.length, "target sentence"));
	return errors.length > 0 ? fail(errors) : { ok: true, value: { groups }, warnings: [] };
}

/** Units merged in one pairing group: at most this many on one side, against exactly one on the other. */
export const MAX_MERGED_UNITS = 3;
const SENTENCE_KINDS: ReadonlySet<string> = new Set(["paragraph", "quote", "callout"]);

/**
 * Paragraph pairing (§7.2): both sides covered exactly once, groups
 * contiguous and monotone, none empty on both sides; a group holds one unit
 * per side, or up to three on one side against one on the other, and only
 * paragraphs, quotes and callouts of one kind merge. A quote never pairs
 * with a paragraph.
 */
export function validatePairing(input: PairingInput, output: unknown): Validation<PairingOutput> {
	const errors: string[] = [];
	const root = asRecord(output);
	const rawGroups = root ? root.groups : undefined;
	if (!root || !Array.isArray(rawGroups) || rawGroups.length === 0) {
		return fail(['the answer must be an object with a non-empty "groups" array']);
	}
	const groups: PairingGroup[] = [];
	rawGroups.forEach((raw: unknown, index) => {
		const group = asRecord(raw);
		const src = group ? integers(group.src) : null;
		const tgt = group ? integers(group.tgt) : null;
		if (!group || src === null || tgt === null) {
			errors.push(`group ${index + 1} must have "src" and "tgt" (arrays of integers)`);
			return;
		}
		const where = `group ${index + 1}`;
		if (src.length === 0 && tgt.length === 0) errors.push(`${where} is empty on both sides`);
		else if (src.length > 1 && tgt.length > 1) errors.push(`${where} pairs several units with several: merge only several with one`);
		else if (src.length > MAX_MERGED_UNITS || tgt.length > MAX_MERGED_UNITS) errors.push(`${where} merges more than ${MAX_MERGED_UNITS} units`);
		else if (src.length > 0 && tgt.length > 0) {
			const kinds = [...src.map((n) => input.source[n - 1]?.kind), ...tgt.map((n) => input.target[n - 1]?.kind)];
			const merged = src.length + tgt.length > 2;
			if (merged && kinds.some((kind) => kind === undefined || !SENTENCE_KINDS.has(kind) || kind !== kinds[0])) {
				errors.push(`${where} merges units of different kinds or units that cannot merge (lists, tables)`);
			} else if (kinds.includes("quote") && kinds.includes("paragraph")) errors.push(`${where} pairs a quote with a paragraph`);
		}
		groups.push({ src, tgt });
	});
	if (errors.length > 0) return fail(errors);
	errors.push(...coverageErrors(groups.map((group) => group.src), input.source.length, "source unit"));
	errors.push(...coverageErrors(groups.map((group) => group.tgt), input.target.length, "target unit"));
	return errors.length > 0 ? fail(errors) : { ok: true, value: { groups }, warnings: [] };
}

/** Placeholders and wikilinks preserved; same line count and per-line structure (list markers, table pipes, footnote continuation). */
export function validatePlain(input: PlainUnitInput, tokens: Protected["tokens"], output: unknown): Validation<PlainOutput> {
	const root = asRecord(output);
	if (!root || typeof root.markdown !== "string") return fail(['the answer must be an object with a "markdown" string']);
	const markdown = root.markdown.replace(/\s+$/, "");
	if (markdown.trim() === "") return fail(['"markdown" is empty']);

	const errors: string[] = [];
	if (markdown.includes("%%")) errors.push("the block contains %%");
	if (hasStrayBracket(markdown)) errors.push(STRAY_BRACKET_ERROR("the block"));
	errors.push(...multisetErrors("placeholder", placeholdersIn(input.markdown), placeholdersIn(markdown), tokens));
	errors.push(...multisetErrors("wikilink", wikilinksIn(input.markdown), wikilinksIn(markdown)));

	const sourceLines = input.markdown.replace(/\s+$/, "").split("\n");
	const targetLines = markdown.split("\n");
	if (sourceLines.length !== targetLines.length) {
		errors.push(`the block must have ${sourceLines.length} lines, found ${targetLines.length}`);
	} else {
		sourceLines.forEach((sourceLine, index) => {
			const problem = lineStructureError(input.kind, sourceLine, targetLines[index] ?? "");
			if (problem) errors.push(`line ${index + 1}: ${problem}`);
		});
	}
	return errors.length > 0 ? fail(errors) : { ok: true, value: { markdown }, warnings: [] };
}

/** Same number of headings; none empty or multi-line. */
export function validateOutline(input: OutlineInput, output: unknown): Validation<OutlineOutput> {
	const root = asRecord(output);
	const raw = root ? root.headings : undefined;
	if (!Array.isArray(raw) || !raw.every((heading): heading is string => typeof heading === "string")) {
		return fail(['the answer must be an object with a "headings" array of strings']);
	}
	const errors: string[] = [];
	if (raw.length !== input.headings.length) errors.push(`expected ${input.headings.length} headings, found ${raw.length}`);
	const headings = raw.map((heading) => heading.trim());
	headings.forEach((heading, index) => {
		if (heading === "") errors.push(`heading ${index + 1} is empty`);
		else if (heading.includes("\n")) errors.push(`heading ${index + 1} spans more than one line`);
		const source = input.headings[index] ?? "";
		if (heading.startsWith("#") && !source.startsWith("#")) errors.push(`heading ${index + 1} starts with "#"`);
		if (heading.includes("%%") && !source.includes("%%")) errors.push(`heading ${index + 1} contains %%`);
		errors.push(...multisetErrors(`wikilink in heading ${index + 1}`, wikilinksIn(source), wikilinksIn(heading)));
	});
	return errors.length > 0 ? fail(errors) : { ok: true, value: { headings }, warnings: [] };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail<T>(errors: readonly string[]): Validation<T> {
	return { ok: false, errors };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function integers(value: unknown): number[] | null {
	return Array.isArray(value) && value.every((n) => Number.isInteger(n)) ? (value as number[]) : null;
}

/**
 * The non-empty lists, in order, must each be consecutive and together
 * read 1..count exactly once.
 */
function coverageErrors(lists: readonly (readonly number[])[], count: number, noun: string): string[] {
	const errors: string[] = [];
	lists.forEach((list, index) => {
		for (let i = 1; i < list.length; i++) {
			if (list[i] !== (list[i - 1] ?? 0) + 1) {
				errors.push(`group ${index + 1} is not a run of consecutive ${noun}s: [${list.join(", ")}]`);
				break;
			}
		}
	});

	const flat = lists.flat();
	const seen = new Map<number, number>();
	for (const n of flat) seen.set(n, (seen.get(n) ?? 0) + 1);
	for (const [n, times] of seen) {
		if (n < 1 || n > count) errors.push(`${noun} ${n} does not exist (there are ${count})`);
		else if (times > 1) errors.push(`${noun} ${n} appears in ${times} groups`);
	}
	for (let n = 1; n <= count; n++) {
		if (!seen.has(n)) errors.push(`${noun} ${n} is missing`);
	}
	if (errors.length === 0 && flat.some((n, i) => n !== i + 1)) errors.push(`groups are not in ${noun} order`);
	return errors;
}

/** Compares two multisets of verbatim strings; `known` names the placeholders protect issued. */
function multisetErrors(noun: string, expected: readonly string[], actual: readonly string[], known?: Protected["tokens"]): string[] {
	const counts = new Map<string, number>();
	for (const item of expected) counts.set(item, (counts.get(item) ?? 0) + 1);
	for (const item of actual) counts.set(item, (counts.get(item) ?? 0) - 1);
	const issued = known ? new Set(known.map((token) => token.placeholder)) : null;

	const errors: string[] = [];
	for (const [item, balance] of counts) {
		const expectedTimes = expected.filter((e) => e === item).length;
		if (balance === 0) continue;
		if (expectedTimes === 0) {
			errors.push(issued && !issued.has(item) ? `${item} is not a placeholder from the source` : `unexpected ${noun} ${item}`);
		} else if (balance === expectedTimes) {
			errors.push(`${noun} ${item} missing`);
		} else {
			errors.push(`${noun} ${item} appears ${expectedTimes - balance} times, expected ${expectedTimes}`);
		}
	}
	return errors;
}

const LINE_START_RE = /\n|⟦BR⟧|⟦P⟧/;
/** Markers that would turn a line into a heading, quote, table row or list item. */
const FORBIDDEN_START_RE = /^\s*(?:[#>|-]|[*+](?=\s|$)|\d{1,9}[.)](?=\s|$))/;
const STRAY_BRACKET_RE = /[⟦⟧]/;
const STRAY_BRACKET_ERROR = (where: string): string => `${where} contains ⟦ or ⟧ outside a placeholder`;
const TRAILING_ID_RE = /\s\^[A-Za-z0-9-]+\s*$/;

/**
 * Markup that would change the block's structure once written into the
 * note. A line may start with a list, quote, table or heading marker only
 * where the group's source has that marker at the start of the same line,
 * as in a callout that holds a list.
 */
function forbiddenContent(markdown: string, source: string, where: string): string[] {
	const errors: string[] = [];
	if (markdown.includes("%%")) errors.push(`${where} contains %%`);
	if (hasStrayBracket(markdown)) errors.push(STRAY_BRACKET_ERROR(where));
	if (/\n[ \t]*\n/.test(markdown)) errors.push(`${where} contains a blank line`);
	const lines = markdown.split(LINE_START_RE);
	if (lines.some((line) => TRAILING_ID_RE.test(line))) errors.push(`${where} ends a line with a block id`);
	const sourceMarkers = source.split(LINE_START_RE).map(lineStartMarker);
	const sameLines = sourceMarkers.length === lines.length;
	for (const [index, line] of lines.entries()) {
		const marker = lineStartMarker(line);
		if (marker === null || (sameLines ? sourceMarkers[index] === marker : sourceMarkers.includes(marker))) continue;
		errors.push(`${where} starts a line with "${marker}"`);
		break;
	}
	return errors;
}

/** The list, quote, table or heading marker a line starts with, or null. */
function lineStartMarker(line: string): string | null {
	return FORBIDDEN_START_RE.exec(line)?.[0].trim() ?? null;
}

/** A lone ⟦ or ⟧ left over once every well-formed placeholder is removed. */
function hasStrayBracket(text: string): boolean {
	return STRAY_BRACKET_RE.test(text.replace(/⟦[^⟦⟧\n]*⟧/g, ""));
}

function lengthWarning(source: string, target: string): string[] {
	const visible = (text: string): number => text.replace(/⟦[^⟦⟧]*⟧/g, "").trim().length;
	const sourceLength = visible(source);
	if (sourceLength === 0) return [];
	const ratio = visible(target) / sourceLength;
	if (ratio >= LENGTH_RATIO_RANGE.min && ratio <= LENGTH_RATIO_RANGE.max) return [];
	return [`the translation is ${ratio.toFixed(2)} times the length of the source`];
}

const LIST_PREFIX_RE = /^(\s*(?:[-*+]|\d+[.)])(?:\s+\[.\])?)(?:\s|$)/;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FOOTNOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*/;
/** A protected definition label, `[^n]:` → `⟦^n⟧:`, which must stay at the start of its line. */
const FOOTNOTE_LABEL_RE = /^⟦\^[^⟦⟧\n]+⟧:/;

/** The structural prefix a translated line must keep, per block kind. */
function lineStructureError(kind: PlainUnitInput["kind"], source: string, target: string): string | null {
	switch (kind) {
		case "list": {
			const expected = LIST_PREFIX_RE.exec(source)?.[1] ?? null;
			const actual = LIST_PREFIX_RE.exec(target)?.[1] ?? null;
			if (expected !== actual) return expected === null ? `unexpected list marker "${actual?.trim()}"` : `expected list marker "${expected.trim()}"`;
			// A continuation line belongs to the item its indentation puts it under.
			if (expected === null && source.trim() !== "" && indent(source) !== indent(target)) return `expected an indentation of ${indent(source)} characters`;
			return null;
		}
		case "table": {
			if (TABLE_DELIMITER_RE.test(source)) return source === target ? null : "the table delimiter row must be copied unchanged";
			const expected = pipeCount(source);
			const actual = pipeCount(target);
			return expected === actual ? null : `expected ${expected} table pipes, found ${actual}`;
		}
		case "footnote": {
			if (source.trim() === "") return target.trim() === "" ? null : "must stay blank";
			if (target.trim() === "") return "must not be blank";
			const label = FOOTNOTE_LABEL_RE.exec(source)?.[0];
			if (label !== undefined && !target.startsWith(label)) return `must start with the footnote label "${label}"`;
			const expected = FOOTNOTE_PREFIX_RE.exec(source)?.[0] ?? "";
			const actual = FOOTNOTE_PREFIX_RE.exec(target)?.[0] ?? "";
			return expected.replace(/\s/g, "") === actual.replace(/\s/g, "") && indent(expected) === indent(actual)
				? null
				: `expected the line to start with "${expected}"`;
		}
	}
}

function pipeCount(line: string): number {
	return (line.replace(/\\\|/g, "").match(/\|/g) ?? []).length;
}

function indent(prefix: string): number {
	return /^[ \t]*/.exec(prefix)?.[0].length ?? 0;
}
