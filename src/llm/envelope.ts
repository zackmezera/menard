/**
 * Parses the CLI's `--output-format json` envelope. Pure.
 * Owner: llm module. DESIGN.md §10.2.
 */
import { MenardError } from "../errors";

/** Missing, expired or revoked sign-in. */
const NOT_LOGGED_IN_RE = /not logged in|\/login|failed to authenticate|authentication_error|invalid api key/i;
/** A momentary capacity problem: retried, never a reason to stop the job. */
const OVERLOADED_RE = /overloaded|\b529\b/i;
/** Usage limits and an exhausted credit balance: nothing will succeed until later. */
const RATE_LIMITED_RE = /usage limit|rate limit|credit balance|\b429\b/i;
/** The exit code of a shell or `env` that could not find the program, such as `node` for an npm install. */
const COMMAND_NOT_FOUND_EXIT = 127;
const FENCE_RE = /^```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```$/;

/** How much CLI text an error message quotes. */
const EXCERPT_CHARS = 300;

/**
 * Returns the structured output (or the `result` text parsed as JSON after
 * stripping a code fence). Throws MenardError: cli-bad-envelope (stdout is
 * not one JSON object), cli-not-logged-in, cli-rate-limited,
 * cli-model-error (other `is_error`, overloaded included), cli-not-found
 * (exit 127, no JSON), cli-crash (other non-zero exit, no JSON).
 * Decides success by `is_error`, never by `subtype`.
 */
export function parseEnvelope(stdout: string, exitCode: number | null, stderr: string): unknown {
	const envelope = parseObject(stdout.trim());
	if (envelope === null) {
		if (exitCode === COMMAND_NOT_FOUND_EXIT) {
			throw new MenardError("cli-not-found", `Claude Code could not start: a program it needs was not found.${quote(stderr)}`, { exitCode, stderr });
		}
		if (exitCode !== 0) {
			throw classify(stderr, stdout) ?? new MenardError("cli-crash", `Claude Code exited with ${describeExit(exitCode)}.${quote(stderr)}`, { exitCode, stderr });
		}
		throw new MenardError("cli-bad-envelope", `Claude Code's reply was not a JSON object.${quote(stdout)}`, { stdout });
	}

	if (envelope.is_error === true) {
		const text = errorText(envelope);
		if (envelope.api_error_status === 401) throw new MenardError("cli-not-logged-in", "Claude Code is not signed in.", text);
		throw classify(text, stderr) ?? new MenardError("cli-model-error", `Claude Code reported an error.${quote(text || stderr)}`, envelope);
	}

	if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
		return envelope.structured_output;
	}
	if (typeof envelope.result !== "string") {
		throw new MenardError("cli-bad-envelope", "Claude Code's reply had neither structured output nor a result.", envelope);
	}
	const payload = stripFence(envelope.result.trim());
	try {
		return JSON.parse(payload) as unknown;
	} catch {
		throw new MenardError("cli-bad-envelope", `Claude Code's result was not JSON.${quote(payload)}`, envelope);
	}
}

function parseObject(text: string): Record<string, unknown> | null {
	if (text === "") return null;
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The error's own words: `result`, plus any `errors` the CLI listed. */
function errorText(envelope: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof envelope.result === "string") parts.push(envelope.result);
	if (Array.isArray(envelope.errors)) {
		for (const error of envelope.errors) parts.push(typeof error === "string" ? error : JSON.stringify(error));
	}
	return parts.join("\n").trim();
}

/**
 * Sign-in, capacity and usage problems, recognized in any of the given
 * texts. An overloaded API is a model error, which callers retry; the
 * other two stop the job.
 */
function classify(...texts: string[]): MenardError | null {
	const text = texts.join("\n");
	if (NOT_LOGGED_IN_RE.test(text)) return new MenardError("cli-not-logged-in", "Claude Code is not signed in.", text);
	if (OVERLOADED_RE.test(text)) return new MenardError("cli-model-error", "Claude is overloaded right now.", text);
	if (RATE_LIMITED_RE.test(text)) return new MenardError("cli-rate-limited", "Claude usage limit reached.", text);
	return null;
}

function stripFence(text: string): string {
	return FENCE_RE.exec(text)?.[1] ?? text;
}

function describeExit(exitCode: number | null): string {
	return exitCode === null ? "a signal" : `code ${exitCode}`;
}

function quote(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	return ` "${trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed}"`;
}
