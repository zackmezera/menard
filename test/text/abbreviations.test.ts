import { describe, expect, it } from "vitest";
import { abbreviationsFor, BUILTIN_ABBREVIATIONS } from "../../src/text/abbreviations";

describe("abbreviationsFor", () => {
	it("ships the DESIGN §5.3 lists for es and en", () => {
		expect(BUILTIN_ABBREVIATIONS.es).toHaveLength(38);
		expect(BUILTIN_ABBREVIATIONS.en).toHaveLength(25);
		expect(abbreviationsFor("es", "").has("dña")).toBe(true);
		expect(abbreviationsFor("en", "").has("e.g")).toBe(true);
	});

	it("matches on the primary subtag", () => {
		expect(abbreviationsFor("es-AR", "")).toEqual(abbreviationsFor("es", ""));
		expect(abbreviationsFor("EN_gb", "").has("trans")).toBe(true);
	});

	it("adds the user's lines for the same language only", () => {
		const extra = "es: art núm Lic.\nen: approx\n  ES-mx : dto, prov.\nsin dos puntos\n";
		const es = abbreviationsFor("es", extra);
		expect(["lic", "dto", "prov"].every((a) => es.has(a))).toBe(true);
		expect(es.has("approx")).toBe(false);
		expect(abbreviationsFor("en", extra).has("approx")).toBe(true);
	});

	it("uses only the user's lines for a language without a built-in list", () => {
		expect([...abbreviationsFor("fr", "fr: M. Mme")]).toEqual(["m", "mme"]);
	});
});
