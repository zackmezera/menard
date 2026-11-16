/**
 * The single error type Menard throws across module boundaries. Codes are
 * stable; user-facing copy for each lives in jobs/ (see docs/DESIGN.md §11).
 */
export type MenardErrorCode =
	// Backend
	| "desktop-only"
	| "cli-not-found"
	| "cli-not-logged-in"
	| "cli-rate-limited"
	| "cli-timeout"
	| "cli-crash"
	| "cli-bad-envelope"
	| "cli-model-error"
	| "cancelled"
	// Model output
	| "output-invalid"
	// Writing
	| "write-conflict"
	| "not-owned"
	| "insert-only-violation"
	| "backup-failed"
	| "backup-stale"
	| "file-exists"
	// Pairs and commands
	| "pair-missing"
	| "pair-not-reciprocal"
	| "split-refused"
	| "split-verification-failed"
	| "reserved-character";

export class MenardError extends Error {
	constructor(
		readonly code: MenardErrorCode,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = "MenardError";
	}
}

export function isMenardError(value: unknown, code?: MenardErrorCode): value is MenardError {
	return value instanceof MenardError && (code === undefined || value.code === code);
}
