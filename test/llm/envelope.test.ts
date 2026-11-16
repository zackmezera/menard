import { describe, expect, it } from "vitest";
import type { MenardErrorCode } from "../../src/errors";
import { isMenardError } from "../../src/errors";
import { parseEnvelope } from "../../src/llm/envelope";

/** Envelope fields as `claude -p --output-format json` prints them. */
function envelope(fields: Record<string, unknown>): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		duration_ms: 4210,
		duration_api_ms: 3980,
		num_turns: 1,
		session_id: "4f0c2a8e-0000-4000-8000-000000000000",
		total_cost_usd: 0.0123,
		usage: { input_tokens: 812, output_tokens: 240 },
		...fields,
	});
}

function codeOf(run: () => unknown): MenardErrorCode | "no error" | "other error" {
	try {
		run();
		return "no error";
	} catch (error) {
		return isMenardError(error) ? error.code : "other error";
	}
}

const GROUPS = { groups: [{ src: [1], markdown: "According to Mr. Pérez, Borges read Poe in Geneva." }] };

describe("parseEnvelope", () => {
	it("returns structured_output on success", () => {
		const stdout = envelope({ result: "", structured_output: GROUPS });
		expect(parseEnvelope(stdout, 0, "")).toEqual(GROUPS);
	});

	it("prefers structured_output over result", () => {
		const stdout = envelope({ result: '{"groups": []}', structured_output: GROUPS });
		expect(parseEnvelope(stdout, 0, "")).toEqual(GROUPS);
	});

	it("parses a result wrapped in a json code fence", () => {
		const stdout = envelope({ result: "```json\n" + JSON.stringify(GROUPS, null, 2) + "\n```" });
		expect(parseEnvelope(stdout, 0, "")).toEqual(GROUPS);
	});

	it("parses an unfenced JSON result", () => {
		expect(parseEnvelope(envelope({ result: JSON.stringify(GROUPS) }), 0, "")).toEqual(GROUPS);
	});

	it("treats is_error as failure even when subtype says success", () => {
		const stdout = envelope({ is_error: true, subtype: "success", result: "Not logged in · Please run /login" });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-not-logged-in");
	});

	it("does not treat an error subtype as failure when is_error is false", () => {
		const stdout = envelope({ subtype: "error_during_execution", structured_output: GROUPS });
		expect(parseEnvelope(stdout, 0, "")).toEqual(GROUPS);
	});

	it.each([
		"Claude AI usage limit reached|1759600800",
		"API Error: 429 rate limit exceeded",
		"Credit balance too low · Add funds: https://console.anthropic.com/settings/billing",
	])("maps a usage limit to cli-rate-limited: %s", (result) => {
		const stdout = envelope({ is_error: true, result });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-rate-limited");
	});

	it("maps an overloaded API to the retried cli-model-error, not a usage limit", () => {
		const stdout = envelope({ is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-model-error");
	});

	it.each([
		"Failed to authenticate: OAuth session expired and could not be refreshed",
		"Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
		'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
	])("maps an expired or revoked sign-in to cli-not-logged-in: %s", (result) => {
		const stdout = envelope({ is_error: true, result });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-not-logged-in");
	});

	it("maps an api_error_status of 401 to cli-not-logged-in", () => {
		const stdout = envelope({ is_error: true, result: "Request failed", api_error_status: 401 });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-not-logged-in");
	});

	it("maps exit 127 without JSON, a script whose interpreter is missing, to cli-not-found", () => {
		expect(codeOf(() => parseEnvelope("", 127, "env: node: No such file or directory\n"))).toBe("cli-not-found");
	});

	it("does not read 429 or 529 inside a longer number as a rate limit", () => {
		const stdout = envelope({ is_error: true, result: "Tool call toolu_01429 failed after 15290 ms" });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-model-error");
	});

	it("maps other errors to cli-model-error", () => {
		const stdout = envelope({ is_error: true, subtype: "error_max_turns", result: undefined, errors: ["Reached maximum number of turns (3)"] });
		expect(codeOf(() => parseEnvelope(stdout, 1, ""))).toBe("cli-model-error");
	});

	it("recognizes a sign-in problem reported only on stderr", () => {
		expect(codeOf(() => parseEnvelope("", 1, "Invalid API key · Please run /login\n"))).toBe("cli-not-logged-in");
	});

	it("rejects garbage stdout as a bad envelope", () => {
		expect(codeOf(() => parseEnvelope("Welcome to Claude Code!\n> ", 0, ""))).toBe("cli-bad-envelope");
	});

	it("rejects a JSON array or scalar as a bad envelope", () => {
		expect(codeOf(() => parseEnvelope("[1, 2]", 0, ""))).toBe("cli-bad-envelope");
		expect(codeOf(() => parseEnvelope('"ok"', 0, ""))).toBe("cli-bad-envelope");
	});

	it("reports empty stdout with a non-zero exit as a crash", () => {
		expect(codeOf(() => parseEnvelope("", 1, "TypeError: Cannot read properties of undefined\n"))).toBe("cli-crash");
	});

	it("reports a crash by signal", () => {
		expect(codeOf(() => parseEnvelope("", null, ""))).toBe("cli-crash");
	});

	it("reports empty stdout with exit 0 as a bad envelope", () => {
		expect(codeOf(() => parseEnvelope("", 0, ""))).toBe("cli-bad-envelope");
	});

	it("rejects a success envelope whose result is not JSON", () => {
		const stdout = envelope({ result: "Here is the translation: According to Mr. Pérez…" });
		expect(codeOf(() => parseEnvelope(stdout, 0, ""))).toBe("cli-bad-envelope");
	});

	it("rejects a success envelope with neither structured_output nor result", () => {
		expect(codeOf(() => parseEnvelope(envelope({}), 0, ""))).toBe("cli-bad-envelope");
	});

	it("quotes the CLI's words in the error message, shortened", () => {
		expect.assertions(2);
		const stdout = envelope({ is_error: true, result: "x".repeat(1000) });
		try {
			parseEnvelope(stdout, 1, "");
		} catch (error) {
			expect((error as Error).message.length).toBeLessThan(400);
			expect((error as Error).message).toContain("…");
		}
	});
});
