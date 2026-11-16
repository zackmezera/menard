/**
 * Prompt text and JSON schemas for each call kind. Pure.
 * Owner: llm module. DESIGN.md §10.3.
 */
import type { AlignUnitInput, OutlineInput, PairingInput, PlainUnitInput, PromptParts, TranslateUnitInput } from "../types";

const integerList = { type: "array", items: { type: "integer", minimum: 1 } } as const;

const SHARED_RULES = [
	"Copy every placeholder such as ⟦^3⟧, ⟦C1⟧, ⟦V1⟧, ⟦U1⟧, ⟦BR⟧ and ⟦P⟧ exactly, as often as it occurs in the source, at the corresponding place. ⟦^…⟧ is a footnote reference, ⟦BR⟧ a line break and ⟦P⟧ a blank line; the others stand for text that must not change.",
	"Copy every wikilink [[…]] exactly as written, including any text after |.",
	"In a Markdown link [label](⟦U1⟧) or [label][⟦U1⟧], translate the label and keep the target.",
	"Keep Markdown emphasis (*, _, **, ==, ~~) on the words that correspond to the emphasized source words.",
	"Translate faithfully and completely in the register of the source. Do not summarize, explain, annotate or add anything.",
	"Never write %% comments or block ids such as ^p12.",
];

/** Schema `{groups:[{src:int[], markdown:string}], calloutTitle?:string}`. */
export function translatePrompt(input: TranslateUnitInput): PromptParts {
	const { source, target } = languageNames(input.languages);
	const hasTitle = input.calloutTitle !== undefined;
	const system = [
		`You translate ${source} into ${target} for a bilingual reading edition, one block of text at a time.`,
		"",
		"The user message is a JSON object:",
		'- "documentTitle": the work being translated, for orientation.',
		`- "unitKind": "paragraph", "quote" or "callout".`,
		'- "sentences": the block to translate, as numbered sentences of Markdown.',
		'- "context": the previous block and its translation, if any. It is read-only: never translate or return it.',
		'- "calloutTitle": present only for a callout with a title; return its translation as "calloutTitle".',
		"- \"extraInstructions\": the reader's own instructions. Follow them unless they conflict with the rules below.",
		"",
		'Return only JSON of the form {"groups": [{"src": [1], "markdown": "…"}]}.',
		"",
		"Rules:",
		...numbered([
			"Write one group per source sentence, in order. Fuse consecutive sentences into one group only when a natural translation cannot keep them apart. Never split a sentence across groups and never move words from one group's sentences into another group.",
			'Every sentence number appears in exactly one group, in ascending order. A group with an empty "src" is allowed only for words the translation must add before the first or after the last sentence, at most once.',
			`Translate quotations too, and use ${target} quotation marks.`,
			...SHARED_RULES,
			"Write no heading markers (#), quote markers (>), list markers or table pipes at the start of a group, and no blank lines.",
		]),
	].join("\n");

	const payload: Record<string, unknown> = {
		documentTitle: input.documentTitle,
		unitKind: input.kind,
		sentences: input.sentences.map((text, index) => ({ n: index + 1, text })),
	};
	if (hasTitle) payload.calloutTitle = input.calloutTitle;
	if (input.context) {
		payload.context = input.context.target === undefined ? { source: input.context.source } : { source: input.context.source, translation: input.context.target };
	}

	const group = {
		type: "object",
		properties: { src: integerList, markdown: { type: "string" } },
		required: ["src", "markdown"],
		additionalProperties: false,
	};
	const schema = {
		type: "object",
		properties: {
			groups: { type: "array", minItems: 1, items: group },
			...(hasTitle ? { calloutTitle: { type: "string" } } : {}),
		},
		required: hasTitle ? ["groups", "calloutTitle"] : ["groups"],
		additionalProperties: false,
	};
	return { system, prompt: userPrompt(payload, input.extraInstructions, input.retryErrors), schema };
}

/** Schema `{groups:[{src:int[], tgt:int[], loose:boolean}]}`; text is never returned. */
export function alignPrompt(input: AlignUnitInput): PromptParts {
	const { source, target } = languageNames(input.languages);
	const system = [
		`You align a ${source} text with its existing ${target} translation, sentence by sentence. You never translate or rewrite anything.`,
		"",
		'The user message is a JSON object with the numbered sentences of one block: "source" in the original and "target" in the translation.',
		"",
		'Return only JSON of the form {"groups": [{"src": [1], "tgt": [1, 2], "loose": false}]}.',
		"",
		"Rules:",
		...numbered([
			"Each group pairs consecutive source sentences with the consecutive target sentences that render them: one to one, one to many or many to one. Keep groups as small as the correspondence allows.",
			"Every source and every target sentence number appears in exactly one group, and the groups follow the order of both texts.",
			"When a stretch on one side has no counterpart on the other, give it its own group with an empty list for the other side instead of forcing a match. Never leave both lists empty.",
			"Every sentence in a group must have its own content rendered on the other side of that group; a shared name (an author cited, the subject of the text) or a single shared word is not a rendering. Test each sentence on its own: one whose content the other side does not render (a quotation, aside or example the translation leaves out, together with its attribution) is its own group with an empty list for the other side, even when its neighbour is rendered. Never fold it into the neighbour's group to avoid an empty list.",
			'For example, source 1 "“Time is a river that carries me away”, writes Borges." and source 2 "Reading, too, carries us off, voraciously." against target 1 "Borges is read voraciously." give {"src": [1], "tgt": [], "loose": false} and {"src": [2], "tgt": [1], "loose": true}: the quotation is not translated, and the shared name does not make it so.',
			'Set "loose" to true when the correspondence is approximate (a free rendering, a partial overlap, or content moved within the group); otherwise false. A faithful translation that changes word order, idiom or punctuation is not loose.',
			"Return sentence numbers only, never text.",
		]),
	].join("\n");

	const payload = {
		source: input.source.map((text, index) => ({ n: index + 1, text })),
		target: input.target.map((text, index) => ({ n: index + 1, text })),
	};
	const group = {
		type: "object",
		properties: { src: integerList, tgt: integerList, loose: { type: "boolean" } },
		required: ["src", "tgt", "loose"],
		additionalProperties: false,
	};
	const schema = {
		type: "object",
		properties: { groups: { type: "array", minItems: 1, items: group } },
		required: ["groups"],
		additionalProperties: false,
	};
	return { system, prompt: userPrompt(payload, "", input.retryErrors), schema };
}

/** Schema `{groups:[{src:int[], tgt:int[]}]}`: the paragraph pairing of one section. */
export function pairingPrompt(input: PairingInput): PromptParts {
	const { source, target } = languageNames(input.languages);
	const system = [
		`You pair the paragraphs of a ${source} text with the paragraphs of its existing ${target} translation, by content. The translation may be free or adapted: the translator may have merged two paragraphs into one, split one into two, left one out or added one. You never translate or rewrite anything.`,
		"",
		'The user message is a JSON object with the numbered units of one section: "source" in the original and "target" in the translation. Each unit gives its kind, its word count and an excerpt: its first words and, when it is longer, its last words after " … ". "ratio" is the target\'s word count over the source\'s for the whole section.',
		"",
		'Return only JSON of the form {"groups": [{"src": [1], "tgt": [1]}, {"src": [2, 3], "tgt": [2]}]}.',
		"",
		"Rules:",
		...numbered([
			"Each group pairs source units with the target units that render the same content: one with one, two or three consecutive source units rendered as one target unit, or one source unit rendered as two or three consecutive target units.",
			"Every source and every target unit number appears in exactly one group, and the groups follow the order of both texts.",
			"A unit with no counterpart gets its own group with an empty list for the other side. Never leave both lists empty.",
			"Judge by content: what the excerpts say, and the names, quotations and numbers in them. A merged target unit starts like the first source unit and ends like the last one (a split, the reverse); its middle is not shown.",
			'Translators rarely drop or add a whole paragraph. Before leaving a unit alone, check whether a neighbouring unit on the other side renders it too. Word counts help here: "ratio" is the section\'s target words per source word, and a target unit far longer than its one source unit at that ratio usually renders the next source unit as well (a merge), while one far shorter suggests a split.',
			"Return unit numbers only, never text.",
		]),
	].join("\n");
	const units = (list: PairingInput["source"]): object[] => list.map((unit, index) => ({ n: index + 1, kind: unit.kind, words: unit.words, excerpt: unit.excerpt }));
	const total = (list: PairingInput["source"]): number => list.reduce((sum, unit) => sum + unit.words, 0);
	const ratio = Math.round((100 * total(input.target)) / Math.max(1, total(input.source))) / 100;
	const payload = { ratio, source: units(input.source), target: units(input.target) };
	const group = {
		type: "object",
		properties: { src: integerList, tgt: integerList },
		required: ["src", "tgt"],
		additionalProperties: false,
	};
	const schema = {
		type: "object",
		properties: { groups: { type: "array", minItems: 1, items: group } },
		required: ["groups"],
		additionalProperties: false,
	};
	return { system, prompt: userPrompt(payload, "", input.retryErrors), schema };
}

const PLAIN_STRUCTURE: Record<PlainUnitInput["kind"], string> = {
	list: "Keep every line's indentation, list marker (with its number) and task box exactly as in the source.",
	table: "Keep every table pipe in place and copy the delimiter row unchanged.",
	footnote: "Keep the footnote's blank lines, indentation and quote markers (>) exactly as in the source.",
};

/** Schema `{markdown:string}`. */
export function plainPrompt(input: PlainUnitInput): PromptParts {
	const { source, target } = languageNames(input.languages);
	const system = [
		`You translate one Markdown block (a ${input.kind}) from ${source} into ${target} for a bilingual reading edition.`,
		"",
		'The user message is a JSON object with "documentTitle" for orientation, "blockKind", the block\'s "markdown", and possibly the reader\'s "extraInstructions", which you follow unless they conflict with the rules below.',
		"",
		'Return only JSON of the form {"markdown": "…"}.',
		"",
		"Rules:",
		...numbered([
			`Keep the line structure: the same number of lines, line for line. ${PLAIN_STRUCTURE[input.kind]}`,
			`Translate quotations too, and use ${target} quotation marks.`,
			...SHARED_RULES,
		]),
	].join("\n");

	const payload = { documentTitle: input.documentTitle, blockKind: input.kind, markdown: input.markdown };
	const schema = {
		type: "object",
		properties: { markdown: { type: "string" } },
		required: ["markdown"],
		additionalProperties: false,
	};
	return { system, prompt: userPrompt(payload, input.extraInstructions, input.retryErrors), schema };
}

/** Schema `{headings:string[]}`, same length and order as the input. */
export function outlinePrompt(input: OutlineInput): PromptParts {
	const { source, target } = languageNames(input.languages);
	const system = [
		`You translate the headings of a ${source} document into ${target}.`,
		"",
		'The user message is a JSON object with "documentTitle" for orientation, the "headings" in document order, and possibly the reader\'s "extraInstructions", which you follow unless they conflict with the rules below.',
		"",
		'Return only JSON of the form {"headings": ["…"]}.',
		"",
		"Rules:",
		...numbered([
			"Return exactly one heading per input heading, in the same order.",
			"Each heading is one line, without # markers.",
			"Keep numbering, wikilinks [[…]] and Markdown emphasis. Return a heading that needs no translation, such as a proper name, unchanged.",
		]),
	].join("\n");

	const payload = { documentTitle: input.documentTitle, headings: input.headings };
	const schema = {
		type: "object",
		properties: {
			headings: { type: "array", items: { type: "string" }, minItems: input.headings.length, maxItems: input.headings.length },
		},
		required: ["headings"],
		additionalProperties: false,
	};
	return { system, prompt: userPrompt(payload, input.extraInstructions, undefined), schema };
}

/** A minimal call for "Check Claude connection": schema `{ok:boolean}`. */
export function pingPrompt(): PromptParts {
	return {
		system: 'You answer connection checks. Return only the JSON {"ok": true}.',
		prompt: "Connection check.",
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
			additionalProperties: false,
		},
	};
}

/** The JSON payload, with the reader's instructions as its last key, then any feedback from a rejected attempt. */
function userPrompt(payload: object, extraInstructions: string, retryErrors: readonly string[] | undefined): string {
	const extra = extraInstructions.trim();
	const body = JSON.stringify(extra === "" ? payload : { ...payload, extraInstructions: extra }, null, 2);
	if (!retryErrors || retryErrors.length === 0) return body;
	return `${body}\n\nYour previous answer was rejected: ${retryErrors.join("; ")}. Return corrected JSON.`;
}

function numbered(rules: readonly string[]): string[] {
	return rules.map((rule, index) => `${index + 1}. ${rule}`);
}

let displayNames: Intl.DisplayNames | undefined;

/** English names for BCP 47 codes ("es" → "Spanish"); an unknown code is used as is. */
export function languageName(code: string): string {
	displayNames ??= new Intl.DisplayNames("en", { type: "language" });
	try {
		return displayNames.of(code) ?? code;
	} catch {
		return code;
	}
}

function languageNames(languages: { source: string; target: string }): { source: string; target: string } {
	return { source: languageName(languages.source), target: languageName(languages.target) };
}
