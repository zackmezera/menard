import { describe, expect, it } from "vitest";
import { footnoteKey } from "../../src/align/model";
import { buildSkeleton, frontmatterBlock, yamlScalar } from "../../src/jobs/skeleton";
import { parseNote } from "../../src/text/blocks";
import type { UnitKey } from "../../src/types";
import { LAYOUT_A } from "./fixtures";

const OPTIONS = { textStartHeading: "Text", skipHeadings: ["Bibliografía", "Argument", "For My Work"] };

describe("buildSkeleton", () => {
	it("builds the translation note skeleton for synthetic fixture (a)", () => {
		const source = parseNote(LAYOUT_A, OPTIONS);
		const keys = new Map<number, UnitKey>();
		const headings = new Map<number, string>();
		let n = 0;
		source.blocks.forEach((block, index) => {
			if (block.region !== "text") return;
			if (block.kind === "footnote") keys.set(index, footnoteKey(block.footnoteLabel ?? ""));
			else if (block.kind === "heading") headings.set(index, `(en) ${block.body}`);
			else if (block.kind !== "verbatim" && block.kind !== "menard") keys.set(index, `p${++n}`);
		});
		const skeleton = buildSkeleton({
			source,
			keys,
			headings,
			frontmatter: { source: '"[[perezlaberinto2019]]"', sourceLanguage: "es", targetLanguage: "en", collection: "translation" },
		});
		expect(skeleton).toBe(
			[
				"---",
				'source: "[[perezlaberinto2019]]"',
				"sourceLanguage: es",
				"targetLanguage: en",
				"collection: translation",
				"---",
				"## (en) I. El laberinto como forma",
				"",
				"%%menard:1 p1 translate%%",
				"",
				"%%menard:1 p2 translate%%",
				"",
				"%%menard:1 p3 translate%%",
				"",
				"## (en) II. La biblioteca",
				"",
				"%%menard:1 p4 translate%%",
				"",
				"# (en) English translation",
				"",
				"%%menard:1 p5 translate%%",
				"",
				"## (en) I. The labyrinth as form",
				"",
				"%%menard:1 p6 translate%%",
				"",
				"%%menard:1 p7 translate%%",
				"",
				"%%menard:1 p8 translate%%",
				"",
				"## (en) II. The library",
				"",
				"%%menard:1 p9 translate%%",
				"",
				"%%menard:1 fn:1 translate%%",
				"",
				"%%menard:1 fn:2 translate%%",
				"",
				"%%menard:1 fn:1 translate%%",
				"",
				"%%menard:1 fn:2 translate%%",
				"",
			].join("\n"),
		);
		expect(skeleton).not.toContain("Bibliografía");
		expect(skeleton).not.toContain("Revista");
		expect(skeleton).not.toContain("Genette");
	});

	it("copies verbatim blocks, keeps untranslated headings, skips unkeyed units and uses CRLF", () => {
		const text = "# Uno\r\n\r\nPrimer párrafo.\r\n\r\n```\r\ncódigo\r\n```\r\n\r\nSegundo párrafo.\r\n";
		const source = parseNote(text, { textStartHeading: "", skipHeadings: [] });
		const skeleton = buildSkeleton({ source, keys: new Map([[1, "p1"]]), headings: new Map(), frontmatter: { targetLanguage: "en" } });
		expect(skeleton).toBe("---\r\ntargetLanguage: en\r\n---\r\n# Uno\r\n\r\n%%menard:1 p1 translate%%\r\n\r\n```\r\ncódigo\r\n```\r\n");
	});
});

describe("frontmatterBlock and yamlScalar", () => {
	it("writes entries between fences", () => {
		expect(frontmatterBlock({ a: "1", b: "x" }, "\n")).toBe("---\na: 1\nb: x\n---\n");
	});

	it("quotes values YAML would misread", () => {
		expect(yamlScalar("translation")).toBe("translation");
		expect(yamlScalar("es")).toBe("es");
		expect(yamlScalar("[[@ruizalmotasim]]")).toBe('"[[@ruizalmotasim]]"');
		expect(yamlScalar("yes")).toBe('"yes"');
		expect(yamlScalar("a: b")).toBe('"a: b"');
		expect(yamlScalar("#tag")).toBe('"#tag"');
	});
});
