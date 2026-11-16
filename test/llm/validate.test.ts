import { describe, expect, it } from "vitest";
import { prepareSentenceUnit, rulesFor } from "../../src/jobs/assemble";
import { protect } from "../../src/llm/protect";
import { validateAlign, validateOutline, validatePairing, validatePlain, validateTranslate } from "../../src/llm/validate";
import { abbreviationsFor } from "../../src/text/abbreviations";
import { parseNote } from "../../src/text/blocks";
import type { AlignUnitInput, OutlineInput, PairingInput, PlainUnitInput, TranslateUnitInput, Validation } from "../../src/types";

const languages = { source: "es", target: "en" };

const SOURCE_SENTENCES = [
	"Según el Sr. Pérez (cf. pp. 23-25), [[Borges, Jorge Luis|Borges]] leyó a Poe en Ginebra.[^1]",
	"Esa lectura, dice, fue «decisiva» para *Ficciones*.",
	"El resto es historia (Ruiz 2002, p. 14).[^en-3]",
];
const protectedSentences = SOURCE_SENTENCES.map((s) => protect(s).text);
const tokens = SOURCE_SENTENCES.flatMap((s) => protect(s).tokens);

const TARGETS = [
	"According to Mr. Pérez (cf. pp. 23-25), [[Borges, Jorge Luis|Borges]] read Poe in Geneva.⟦^1⟧",
	"That reading, he says, was “decisive” for *Ficciones*.",
	"The rest is history (Ruiz 2002, p. 14).⟦^en-3⟧",
];

function translateInput(extra: Partial<TranslateUnitInput> = {}): TranslateUnitInput {
	return {
		key: "p4",
		kind: "paragraph",
		languages,
		documentTitle: "Las versiones homéricas",
		sentences: protectedSentences,
		extraInstructions: "",
		...extra,
	};
}

function groups(...pairs: [number[], string][]): { groups: { src: number[]; markdown: string }[] } {
	return { groups: pairs.map(([src, markdown]) => ({ src, markdown })) };
}

const GOOD = groups([[1], TARGETS[0]!], [[2], TARGETS[1]!], [[3], TARGETS[2]!]);

function errorsOf<T>(result: Validation<T>): readonly string[] {
	return result.ok ? [] : result.errors;
}

describe("validateTranslate", () => {
	it("accepts a faithful one-group-per-sentence answer", () => {
		const result = validateTranslate(translateInput(), tokens, GOOD);
		expect(result).toEqual({ ok: true, value: GOOD, warnings: [] });
	});

	it("accepts fused consecutive sentences and trims group text", () => {
		const output = groups([[1, 2], `  ${TARGETS[0]} ${TARGETS[1]}  `], [[3], TARGETS[2]!]);
		const result = validateTranslate(translateInput(), tokens, output);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.groups[0]?.markdown).toBe(`${TARGETS[0]} ${TARGETS[1]}`);
	});

	it("accepts one leading or one trailing addition group", () => {
		expect(validateTranslate(translateInput(), tokens, groups([[], "Indeed:"], ...GOOD.groups.map((g) => [g.src, g.markdown] as [number[], string]))).ok).toBe(true);
		expect(validateTranslate(translateInput(), tokens, groups(...GOOD.groups.map((g) => [g.src, g.markdown] as [number[], string]), [[], "So it goes."])).ok).toBe(true);
	});

	it.each([
		["not an object", "nope"],
		["no groups", {}],
		["empty groups", { groups: [] }],
		["src not integers", { groups: [{ src: ["1"], markdown: "x" }] }],
		["markdown missing", { groups: [{ src: [1] }] }],
	])("rejects a malformed answer: %s", (_name, output) => {
		expect(validateTranslate(translateInput(), tokens, output).ok).toBe(false);
	});

	it("rejects two addition groups", () => {
		const output = groups([[], "Indeed:"], [[1], TARGETS[0]!], [[2], TARGETS[1]!], [[3], TARGETS[2]!], [[], "So it goes."]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain('only one group may have an empty "src", found 2');
	});

	it("rejects an addition group in the middle", () => {
		const output = groups([[1], TARGETS[0]!], [[], "Indeed:"], [[2], TARGETS[1]!], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain('group 2 has an empty "src" but is neither the first nor the last group');
	});

	it("rejects an answer made only of additions", () => {
		const errors = errorsOf(validateTranslate(translateInput({ sentences: ["Hola."] }), [], groups([[], "Hello."])));
		expect(errors).toContain('every group has an empty "src"');
		expect(errors).toContain("sentence 1 is missing");
	});

	it("rejects a missing sentence", () => {
		const output = groups([[1], TARGETS[0]!], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain("sentence 2 is missing");
	});

	it("rejects a duplicated sentence", () => {
		const output = groups([[1], TARGETS[0]!], [[2], TARGETS[1]!], [[2, 3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain("sentence 2 appears in 2 groups");
	});

	it("rejects a sentence number out of range", () => {
		const output = groups(...GOOD.groups.map((g) => [g.src, g.markdown] as [number[], string]), [[4], "Extra."]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain("sentence 4 does not exist (there are 3)");
	});

	it("rejects a group that is not consecutive", () => {
		const output = groups([[1, 3], `${TARGETS[0]} ${TARGETS[2]}`], [[2], TARGETS[1]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain("group 1 is not a run of consecutive sentences: [1, 3]");
	});

	it("rejects groups out of order", () => {
		const output = groups([[2], TARGETS[1]!], [[1], TARGETS[0]!], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toEqual(["groups are not in sentence order"]);
	});

	it("rejects a group with no text", () => {
		const output = groups([[1], TARGETS[0]!], [[2], "  "], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toContain("group 2 has no text");
	});

	it("rejects a missing placeholder", () => {
		const output = groups([[1], TARGETS[0]!.replace("⟦^1⟧", "")], [[2], TARGETS[1]!], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toEqual(["placeholder ⟦^1⟧ missing"]);
	});

	it("rejects a duplicated placeholder", () => {
		const output = groups([[1], TARGETS[0]!], [[2], `${TARGETS[1]}⟦^1⟧`], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toEqual(["placeholder ⟦^1⟧ appears 2 times, expected 1"]);
	});

	it("rejects an invented placeholder", () => {
		const output = groups([[1], TARGETS[0]!], [[2], `${TARGETS[1]} ⟦V7⟧`], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toEqual(["⟦V7⟧ is not a placeholder from the source"]);
	});

	it("rejects a changed wikilink", () => {
		const output = groups([[1], TARGETS[0]!.replace("|Borges]]", "|Jorge Luis Borges]]")], [[2], TARGETS[1]!], [[3], TARGETS[2]!]);
		expect(errorsOf(validateTranslate(translateInput(), tokens, output))).toEqual([
			"wikilink [[Borges, Jorge Luis|Borges]] missing",
			"unexpected wikilink [[Borges, Jorge Luis|Jorge Luis Borges]]",
		]);
	});

	it.each([
		["%%", "That reading %%p. 3%% was decisive."],
		["blank line", "That reading,\n\nhe says, was decisive."],
		["trailing id", "That reading was decisive. ^p9"],
		["heading", "# That reading was decisive."],
		["quote", "> That reading was decisive."],
		["list", "- That reading was decisive."],
		["table", "| That reading | was decisive. |"],
		["marker after ⟦BR⟧", "That reading⟦BR⟧> was decisive."],
		["bullet list", "* That reading was decisive."],
		["plus list", "+ That reading was decisive."],
		["ordered list", "1939. That reading was decisive."],
		["ordered list after a soft break", "That reading\n2) was decisive."],
		["stray placeholder bracket", "That reading⟧ was decisive."],
	])("rejects forbidden content: %s", (_name, markdown) => {
		const output = groups([[1], TARGETS[0]!], [[2], markdown], [[3], TARGETS[2]!]);
		const errors = errorsOf(validateTranslate(translateInput(), tokens, output));
		expect(errors.some((e) => e.startsWith("group 2 "))).toBe(true);
	});

	it("allows emphasis and numbers that are not list markers at the start of a group", () => {
		const output = groups([[1], TARGETS[0]!], [[2], "*Ficciones* owed that reading, he says, a “decisive” debt in 1939."], [[3], TARGETS[2]!]);
		expect(validateTranslate(translateInput(), tokens, output).ok).toBe(true);
	});

	it("allows an em-dash at the start of a group", () => {
		const output = groups([[1], TARGETS[0]!], [[2], "—That reading, he says, was “decisive” for *Ficciones*."], [[3], TARGETS[2]!]);
		expect(validateTranslate(translateInput(), tokens, output).ok).toBe(true);
	});

	it("warns, without failing, when the length ratio is out of range", () => {
		const short = groups([[1], "Borges.⟦^1⟧ [[Borges, Jorge Luis|Borges]]"], [[2], "Yes."], [[3], "So.⟦^en-3⟧"]);
		const result = validateTranslate(translateInput(), tokens, short);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.warnings).toEqual([expect.stringMatching(/^the translation is 0\.\d\d times the length of the source$/)]);

		const long = groups([[1], TARGETS[0]!.repeat(1)], [[2], TARGETS[1]!.repeat(12)], [[3], TARGETS[2]!]);
		const longResult = validateTranslate(translateInput(), tokens, long);
		expect(longResult.ok && longResult.warnings.length).toBe(1);
	});

	describe("callouts", () => {
		const input = translateInput({ kind: "callout", calloutTitle: "Procedencia", sentences: ["Texto cedido por la autora."] });

		it("requires and returns the translated title", () => {
			const result = validateTranslate(input, [], { groups: [{ src: [1], markdown: "Text courtesy of the author." }], calloutTitle: " Provenance " });
			expect(result.ok && result.value.calloutTitle).toBe("Provenance");
		});

		it("rejects a missing or multi-line title", () => {
			const output = { groups: [{ src: [1], markdown: "Text courtesy of the author." }] };
			expect(errorsOf(validateTranslate(input, [], output))).toEqual(['"calloutTitle" is missing or empty']);
			expect(errorsOf(validateTranslate(input, [], { ...output, calloutTitle: "Pro\nvenance" }))).toEqual(['"calloutTitle" must be a single line']);
		});

		it("checks the title's placeholders, wikilinks and content on their own", () => {
			const title = protect("Procedencia, según [[Ruiz, A.]][^1]");
			const titled = translateInput({ kind: "callout", calloutTitle: title.text, sentences: ["Texto cedido por la autora."] });
			const body = { groups: [{ src: [1], markdown: "Text courtesy of the author." }] };
			expect(validateTranslate(titled, title.tokens, { ...body, calloutTitle: "1. Provenance, per [[Ruiz, A.]]⟦^1⟧" }).ok).toBe(true);
			expect(errorsOf(validateTranslate(titled, title.tokens, { ...body, calloutTitle: "Provenance, per Ruiz %%x%% ^p1" }))).toEqual([
				'"calloutTitle" contains %%',
				'"calloutTitle" ends with a block id',
				"placeholder in calloutTitle ⟦^1⟧ missing",
				"wikilink in calloutTitle [[Ruiz, A.]] missing",
			]);
		});

		it("drops a title the unit did not ask for", () => {
			const result = validateTranslate(translateInput(), tokens, { ...GOOD, calloutTitle: "Stray" });
			expect(result.ok && result.value).toEqual(GOOD);
		});
	});
});

describe("validateAlign", () => {
	const input: AlignUnitInput = {
		key: "p7",
		languages,
		source: ["Según el Sr. Pérez, Borges leyó a Poe.", "Esa lectura fue decisiva.", "Lo demás es historia."],
		target: ["According to Mr. Pérez, Borges read Poe.", "He read him in Geneva.", "That reading was decisive.", "The rest is history."],
	};
	const align = (...g: [number[], number[], boolean?][]) => ({ groups: g.map(([src, tgt, loose]) => ({ src, tgt, loose: loose ?? false })) });

	it("accepts one-to-many, flagged spans and loose groups", () => {
		const output = align([[1], [1, 2]], [[2], [3], true], [[3], [4]]);
		expect(validateAlign(input, output)).toEqual({ ok: true, value: output, warnings: [] });
		expect(validateAlign(input, align([[1], [1]], [[], [2]], [[2], [3]], [[3], [4]])).ok).toBe(true);
	});

	it("rejects a group empty on both sides", () => {
		expect(errorsOf(validateAlign(input, align([[1], [1, 2]], [[], []], [[2, 3], [3, 4]])))).toEqual(["group 2 is empty on both sides"]);
	});

	it("rejects a malformed group", () => {
		expect(errorsOf(validateAlign(input, { groups: [{ src: [1], tgt: [1] }] }))[0]).toMatch(/^group 1 must have/);
		expect(validateAlign(input, { groups: [] }).ok).toBe(false);
	});

	it("rejects missing and duplicated sentences on either side", () => {
		const errors = errorsOf(validateAlign(input, align([[1], [1, 2]], [[1, 2], [3]], [[3], [3]])));
		expect(errors).toContain("source sentence 1 appears in 2 groups");
		expect(errors).toContain("target sentence 3 appears in 2 groups");
		expect(errors).toContain("target sentence 4 is missing");
	});

	it("rejects non-contiguous and non-monotone groups", () => {
		expect(errorsOf(validateAlign(input, align([[1, 3], [1, 2, 4]], [[2], [3]])))).toEqual([
			"group 1 is not a run of consecutive source sentences: [1, 3]",
			"group 1 is not a run of consecutive target sentences: [1, 2, 4]",
		]);
		expect(errorsOf(validateAlign(input, align([[2], [1, 2]], [[1], [3]], [[3], [4]])))).toEqual(["groups are not in source sentence order"]);
	});
});

describe("validatePlain", () => {
	function plainInput(kind: PlainUnitInput["kind"], markdown: string): PlainUnitInput {
		return { key: kind === "footnote" ? "fn:3" : "p9", kind, languages, documentTitle: "Ensayo", markdown, extraInstructions: "" };
	}

	it("accepts a list with markers, numbers, tasks and indentation kept", () => {
		const input = plainInput("list", "1. Primera edición (Sur, 1939).[^2]\n2. Segunda edición:\n    - [ ] cotejar con [[Ruiz, A.]]\n    - prólogo");
		const output = { markdown: "1. First edition (Sur, 1939).⟦^2⟧\n2. Second edition:\n    - [ ] check against [[Ruiz, A.]]\n    - preface\n" };
		const result = validatePlain({ ...input, markdown: protect(input.markdown, { lineBreaks: "keep" }).text }, [], output);
		expect(result).toEqual({ ok: true, value: { markdown: output.markdown.trimEnd() }, warnings: [] });
	});

	it("rejects a changed list marker and a changed line count", () => {
		const input = plainInput("list", "- uno\n- dos");
		expect(errorsOf(validatePlain(input, [], { markdown: "* one\n- two" }))).toEqual(['line 1: expected list marker "-"']);
		expect(errorsOf(validatePlain(input, [], { markdown: "- one\n- two\n- three" }))).toEqual(["the block must have 2 lines, found 3"]);
		expect(errorsOf(validatePlain(plainInput("list", "- uno\n  sigue"), [], { markdown: "- one\n- goes on" }))).toEqual(['line 2: unexpected list marker "-"']);
	});

	it("keeps the indentation of a list item's continuation line", () => {
		const input = plainInput("list", "- uno\n    - dos\n      sigue");
		expect(validatePlain(input, [], { markdown: "- one\n    - two\n      goes on" }).ok).toBe(true);
		expect(errorsOf(validatePlain(input, [], { markdown: "- one\n    - two\ngoes on" }))).toEqual(["line 3: expected an indentation of 6 characters"]);
	});

	it("keeps a footnote definition label at the start of its line", () => {
		const source = protect("[^3]: Véase la carta.", { lineBreaks: "keep" });
		const input = plainInput("footnote", source.text);
		expect(validatePlain(input, source.tokens, { markdown: "⟦^3⟧: See the letter." }).ok).toBe(true);
		expect(errorsOf(validatePlain(input, source.tokens, { markdown: "See the letter.⟦^3⟧:" }))).toEqual(['line 1: must start with the footnote label "⟦^3⟧:"']);
	});

	it("rejects a stray placeholder bracket", () => {
		expect(errorsOf(validatePlain(plainInput("list", "- uno"), [], { markdown: "- one ⟦" }))).toEqual(["the block contains ⟦ or ⟧ outside a placeholder"]);
	});

	it("checks table pipes and copies the delimiter row", () => {
		const input = plainInput("table", "| Año | Título |\n|:---|---:|\n| 1932 | *Discusión* |");
		expect(validatePlain(input, [], { markdown: "| Year | Title |\n|:---|---:|\n| 1932 | *Discussion* |" }).ok).toBe(true);
		expect(errorsOf(validatePlain(input, [], { markdown: "| Year | Title |\n|---|---|\n| 1932 | *Discussion* |" }))).toEqual([
			"line 2: the table delimiter row must be copied unchanged",
		]);
		expect(errorsOf(validatePlain(input, [], { markdown: "| Year | Title |\n|:---|---:|\n| 1932 | *Discussion* | x |" }))).toEqual([
			"line 3: expected 3 table pipes, found 4",
		]);
	});

	it("checks footnote blank lines and nested quotes", () => {
		const input = plainInput("footnote", "Véase la carta de 1939.\n\n> «No hay tal cosa», escribió.");
		expect(validatePlain(input, [], { markdown: "See the 1939 letter.\n\n> “There is no such thing,” he wrote." }).ok).toBe(true);
		expect(errorsOf(validatePlain(input, [], { markdown: "See the 1939 letter.\nAlso.\n> “There is no such thing,” he wrote." }))).toEqual(["line 2: must stay blank"]);
		expect(errorsOf(validatePlain(input, [], { markdown: "See the 1939 letter.\n\n“There is no such thing,” he wrote." }))).toEqual([
			'line 3: expected the line to start with "> "',
		]);
		expect(errorsOf(validatePlain(plainInput("footnote", "Uno.\nDos.\nTres."), [], { markdown: "One.\n\nThree." }))).toEqual(["line 2: must not be blank"]);
	});

	it("rejects lost placeholders, changed wikilinks and %%", () => {
		const source = protect("- Véase [[@borgesversiones1932]].[^4]", { lineBreaks: "keep" });
		const input = plainInput("list", source.text);
		expect(errorsOf(validatePlain(input, source.tokens, { markdown: "- See [[@borgesversiones1932|the essay]]. %%x%%" }))).toEqual([
			"the block contains %%",
			"placeholder ⟦^4⟧ missing",
			"wikilink [[@borgesversiones1932]] missing",
			"unexpected wikilink [[@borgesversiones1932|the essay]]",
		]);
	});

	it("rejects a malformed or empty answer", () => {
		expect(validatePlain(plainInput("list", "- a"), [], { text: "- a" }).ok).toBe(false);
		expect(errorsOf(validatePlain(plainInput("list", "- a"), [], { markdown: " \n" }))).toEqual(['"markdown" is empty']);
	});
});

describe("validateOutline", () => {
	const input: OutlineInput = { languages, documentTitle: "Ficciones", headings: ["Prólogo", "El jardín de senderos que se bifurcan", "Notas"], extraInstructions: "" };

	it("accepts the same number of single-line headings, trimmed", () => {
		const result = validateOutline(input, { headings: ["Prologue", " The Garden of Forking Paths ", "Notes"] });
		expect(result).toEqual({ ok: true, value: { headings: ["Prologue", "The Garden of Forking Paths", "Notes"] }, warnings: [] });
	});

	it("rejects a different count, empty or multi-line headings, and malformed answers", () => {
		expect(errorsOf(validateOutline(input, { headings: ["Prologue", "Notes"] }))).toEqual(["expected 3 headings, found 2"]);
		expect(errorsOf(validateOutline(input, { headings: ["Prologue", " ", "Notes\nand more"] }))).toEqual([
			"heading 2 is empty",
			"heading 3 spans more than one line",
		]);
		expect(validateOutline(input, { headings: [1, 2, 3] }).ok).toBe(false);
		expect(validateOutline(input, null).ok).toBe(false);
	});

	it("rejects a heading marker, a comment or a changed wikilink the source heading did not have", () => {
		const linked: OutlineInput = { ...input, headings: ["Prólogo", "Sobre [[Borges, Jorge Luis|Borges]]", "Notas %%p. 9%%"] };
		expect(validateOutline(linked, { headings: ["Prologue", "On [[Borges, Jorge Luis|Borges]]", "Notes %%p. 9%%"] }).ok).toBe(true);
		expect(errorsOf(validateOutline(linked, { headings: ["# Prologue", "On Borges", "Notes"] }))).toEqual([
			'heading 1 starts with "#"',
			"wikilink in heading 2 [[Borges, Jorge Luis|Borges]] missing",
		]);
		expect(errorsOf(validateOutline(input, { headings: ["Prologue %%x%%", "The Garden", "Notes"] }))).toEqual(["heading 1 contains %%"]);
	});
});

describe("validateTranslate on quotes and callouts with inner structure", () => {
	const ES = { lang: "es", abbreviations: abbreviationsFor("es", ""), splitDialogue: false };

	function unchangedCopy(markdown: string): Validation<unknown> {
		const block = parseNote(markdown, { textStartHeading: "", skipHeadings: [] }).blocks[0];
		if (block === undefined || (block.kind !== "quote" && block.kind !== "callout")) throw new Error("not a quote or callout");
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		const input = translateInput({ kind: block.kind, sentences: prepared.protectedSentences });
		const groups = prepared.protectedSentences.map((text, i) => ({ src: [i + 1], markdown: text }));
		return validateTranslate(input, prepared.tokens, { groups });
	}

	it("accepts list items and nested quotes that the source lines also start with", () => {
		expect(unchangedCopy("> [!note] Notas\n> - primer punto aquí.\n> - segundo punto aquí.\n").ok).toBe(true);
		expect(unchangedCopy("> Cita.\n> > Cita anidada aquí.\n").ok).toBe(true);
	});

	it("still rejects a marker the source line does not have", () => {
		const block = parseNote("> Una frase. Otra frase.\n", { textStartHeading: "", skipHeadings: [] }).blocks[0];
		if (block === undefined) throw new Error("no block");
		const prepared = prepareSentenceUnit(block, rulesFor(block, ES));
		const input = translateInput({ kind: "quote", sentences: prepared.protectedSentences });
		const result = validateTranslate(input, prepared.tokens, { groups: [{ src: [1, 2], markdown: "One sentence.⟦BR⟧- Another sentence." }] });
		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.errors).toContain('group 1 starts a line with "-"');
	});
});

describe("validatePairing", () => {
	const unit = (kind: PairingInput["source"][number]["kind"]): PairingInput["source"][number] => ({ kind, words: 50, excerpt: "…" });
	const input: PairingInput = {
		languages: { source: "es", target: "en" },
		source: [unit("paragraph"), unit("paragraph"), unit("paragraph"), unit("quote"), unit("list")],
		target: [unit("paragraph"), unit("paragraph"), unit("quote"), unit("list")],
	};
	const errorsOf = (groups: unknown): readonly string[] => {
		const result = validatePairing(input, { groups });
		return result.ok ? [] : result.errors;
	};

	it("accepts 1-1, merges, and one-sided groups in order", () => {
		const groups = [
			{ src: [1, 2], tgt: [1] },
			{ src: [3], tgt: [] },
			{ src: [], tgt: [2] },
			{ src: [4], tgt: [3] },
			{ src: [5], tgt: [4] },
		];
		expect(validatePairing(input, { groups })).toEqual({ ok: true, value: { groups }, warnings: [] });
	});

	it("rejects many-to-many, oversize, mixed-kind and quote-paragraph groups", () => {
		expect(errorsOf([{ src: [1, 2], tgt: [1, 2] }, { src: [3, 4, 5], tgt: [3, 4] }])[0]).toBe("group 1 pairs several units with several: merge only several with one");
		expect(errorsOf([{ src: [1, 2, 3, 4], tgt: [1] }])[0]).toBe("group 1 merges more than 3 units");
		expect(errorsOf([{ src: [1, 2, 3], tgt: [1] }, { src: [4, 5], tgt: [2] }])).toContain("group 2 merges units of different kinds or units that cannot merge (lists, tables)");
		expect(errorsOf([{ src: [1, 2, 3], tgt: [1, 2] }, { src: [4], tgt: [3] }])[0]).toBe("group 1 pairs several units with several: merge only several with one");
		expect(errorsOf([{ src: [1, 2, 3], tgt: [1] }, { src: [4], tgt: [2] }, { src: [5], tgt: [3, 4] }])).toContain("group 2 pairs a quote with a paragraph");
	});

	it("checks coverage and order on both sides", () => {
		expect(errorsOf([{ src: [2], tgt: [1] }, { src: [1], tgt: [2] }, { src: [3, 4, 5], tgt: [] }, { src: [], tgt: [3, 4] }])).toContain("groups are not in source unit order");
		expect(errorsOf([{ src: [1, 2, 3], tgt: [1, 2] }])).not.toEqual([]);
		expect(errorsOf([{ src: [], tgt: [] }])).toEqual(["group 1 is empty on both sides"]);
		expect(errorsOf("nope")).toEqual(['the answer must be an object with a non-empty "groups" array']);
	});
});
