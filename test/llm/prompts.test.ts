import { describe, expect, it } from "vitest";
import { alignPrompt, languageName, outlinePrompt, pingPrompt, plainPrompt, translatePrompt } from "../../src/llm/prompts";
import { protect } from "../../src/llm/protect";
import type { TranslateUnitInput } from "../../src/types";

const languages = { source: "es", target: "en" };

const translateInput: TranslateUnitInput = {
	key: "p12",
	kind: "paragraph",
	languages,
	documentTitle: "Las versiones homéricas",
	sentences: [
		"Según el Sr. Pérez (cf. pp. 23-25), [[Borges, Jorge Luis|Borges]] leyó a Poe en Ginebra.[^1]",
		"Esa lectura, dice, fue «decisiva» para *Ficciones*.",
	].map((s) => protect(s).text),
	context: { source: "Ningún problema tan consustancial con las letras.", target: "No problem is as consubstantial with letters." },
	extraInstructions: "Use British spelling.",
};

describe("translatePrompt", () => {
	it("matches the snapshot", () => {
		expect(translatePrompt(translateInput)).toMatchSnapshot();
	});

	it("sends numbered sentences, title, context, and the reader's instructions last", () => {
		const payload = JSON.parse(translatePrompt(translateInput).prompt) as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual(["documentTitle", "unitKind", "sentences", "context", "extraInstructions"]);
		expect(payload.sentences).toEqual([
			{ n: 1, text: "Según el Sr. Pérez (cf. pp. 23-25), [[Borges, Jorge Luis|Borges]] leyó a Poe en Ginebra.⟦^1⟧" },
			{ n: 2, text: "Esa lectura, dice, fue «decisiva» para *Ficciones*." },
		]);
		expect(payload.context).toEqual({ source: translateInput.context?.source, translation: translateInput.context?.target });
	});

	it("names the languages in the system prompt", () => {
		const { system } = translatePrompt(translateInput);
		expect(system).toContain("You translate Spanish into English");
		expect(system).toContain("use English quotation marks");
	});

	it("asks for and requires a callout title only for titled callouts", () => {
		const parts = translatePrompt({ ...translateInput, kind: "callout", calloutTitle: "Procedencia", context: undefined, extraInstructions: "" });
		expect(parts).toMatchSnapshot();
		const payload = JSON.parse(parts.prompt) as Record<string, unknown>;
		expect(payload.calloutTitle).toBe("Procedencia");
		expect("extraInstructions" in payload).toBe(false);
		expect((parts.schema as { required: string[] }).required).toEqual(["groups", "calloutTitle"]);
		expect((translatePrompt(translateInput).schema as { properties: object }).properties).not.toHaveProperty("calloutTitle");
	});

	it("appends the errors of a rejected attempt", () => {
		const { prompt } = translatePrompt({ ...translateInput, retryErrors: ["placeholder ⟦^1⟧ missing", "sentence 2 is missing"] });
		expect(prompt.endsWith("\n\nYour previous answer was rejected: placeholder ⟦^1⟧ missing; sentence 2 is missing. Return corrected JSON.")).toBe(true);
	});
});

describe("alignPrompt", () => {
	it("matches the snapshot", () => {
		expect(
			alignPrompt({
				key: "p3",
				languages,
				source: ["Según el Sr. Pérez, Borges leyó a Poe.", "Esa lectura fue decisiva."],
				target: ["According to Mr. Pérez, Borges read Poe.", "He read him in Geneva.", "That reading was decisive."],
				retryErrors: ["target sentence 2 is missing"],
			}),
		).toMatchSnapshot();
	});
});

describe("plainPrompt", () => {
	it.each(["list", "table", "footnote"] as const)("matches the snapshot for a %s", (kind) => {
		const markdown = { list: "- Primera edición (Sur, 1939).", table: "| Año | Título |\n|---|---|\n| 1932 | *Discusión* |", footnote: "Véase la carta de 1939." }[kind];
		expect(plainPrompt({ key: "p9", kind, languages, documentTitle: "Discusión", markdown, extraInstructions: "" })).toMatchSnapshot();
	});
});

describe("outlinePrompt", () => {
	it("matches the snapshot and pins the heading count in the schema", () => {
		const parts = outlinePrompt({ languages, documentTitle: "Ficciones", headings: ["Prólogo", "El jardín de senderos que se bifurcan"], extraInstructions: "" });
		expect(parts).toMatchSnapshot();
		expect(parts.schema).toMatchObject({ properties: { headings: { minItems: 2, maxItems: 2 } } });
	});
});

describe("pingPrompt", () => {
	it("matches the snapshot", () => {
		expect(pingPrompt()).toMatchSnapshot();
	});
});

describe("languageName", () => {
	it("names known codes in English and passes unknown ones through", () => {
		expect(languageName("es")).toBe("Spanish");
		expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
		expect(languageName("not a code!")).toBe("not a code!");
	});
});
