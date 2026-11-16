/**
 * The only module that writes note content (ADR 0009). Owner: vault module.
 * DESIGN.md §8.
 *
 * Every content write runs inside `vault.process`, so its edit is computed
 * from the file's current text. When a class guarantee fails, the callback
 * returns the text it was given and the outcome carries the error.
 */
import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { isMenardLine } from "../constants";
import { MenardError, isMenardError } from "../errors";
import { applyInserts, applyReplacements, isInsertOnly, locateMenardLines } from "../text/edits";
import type {
	BackupToken,
	ComputeInserts,
	ComputeReplacements,
	Insert,
	NoteWriter,
	Replacement,
	WriteOutcome,
} from "../types";
import { contentHash } from "./backup";

export class SafeWriter implements NoteWriter {
	/** Tail of the write chain per path; Menard's own writes to one file never interleave. */
	private readonly chains = new Map<string, Promise<void>>();

	constructor(private readonly app: App) {}

	insert(file: TFile, compute: ComputeInserts): Promise<WriteOutcome> {
		return this.write(file, (text) => {
			const inserts = computed(compute(text), file);
			if (inserts === null) return text;
			const eol = eolOf(text);
			const normalized: Insert[] = inserts.map((insert) => ({ at: insert.at, text: withEol(insert.text, eol) }));
			for (const { at } of normalized) {
				if (!isOffset(text, at)) {
					throw new MenardError("write-conflict", "An insertion lies outside the current text.");
				}
				if (splitsCharacter(text, at)) {
					throw new MenardError("insert-only-violation", "An insertion falls inside a line ending or a character.");
				}
			}
			const result = applyInserts(text, normalized);
			if (!isInsertOnly(text, result, normalized)) {
				throw new MenardError("insert-only-violation", "The edit changed text it was only meant to add to.");
			}
			return result;
		});
	}

	rewriteOwned(file: TFile, compute: ComputeReplacements): Promise<WriteOutcome> {
		return this.write(file, (text) => {
			const replacements = computed(compute(text), file);
			if (replacements === null) return text;
			const owned = new Set(locateMenardLines(text).map(({ from, to }) => `${from}:${to}`));
			for (const { from, to, expect } of replacements) {
				if (!isMenardLine(expect)) {
					throw new MenardError("not-owned", "Only Menard lines may be rewritten.", expect);
				}
				if (!isOffset(text, from) || !isOffset(text, to) || text.slice(from, to) !== expect) {
					throw new MenardError("write-conflict", "The Menard line is no longer where it was.", expect);
				}
				if (!owned.has(`${from}:${to}`)) {
					throw new MenardError("not-owned", "Only whole Menard lines outside code blocks may be rewritten.", expect);
				}
			}
			return this.applyChecked(text, replacements);
		});
	}

	replace(file: TFile, backup: BackupToken, compute: ComputeReplacements): Promise<WriteOutcome> {
		return this.write(file, (text) => {
			if (backup.path !== file.path || backup.contentHash !== contentHash(text)) {
				throw new MenardError("backup-stale", "The note changed after it was backed up.", backup.backupPath);
			}
			const replacements = computed(compute(text), file);
			if (replacements === null) return text;
			return this.applyChecked(text, replacements);
		});
	}

	create(path: string, content: string): Promise<TFile> {
		const normalized = normalizePath(path);
		return this.serialize(normalized, async () => {
			if (this.app.vault.getAbstractFileByPath(normalized)) {
				throw new MenardError("file-exists", `${normalized} already exists.`);
			}
			return this.app.vault.create(normalized, content);
		});
	}

	setFrontmatter(file: TFile, entries: Readonly<Record<string, string>>): Promise<void> {
		return this.serialize(file.path, () =>
			this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				for (const [key, value] of Object.entries(entries)) frontmatter[key] = value;
			}),
		);
	}

	trashCreated(file: TFile): Promise<void> {
		return this.serialize(file.path, () => this.app.fileManager.trashFile(file));
	}

	/**
	 * Runs `edit` inside vault.process, serialized per path. `edit` returns the
	 * new text, or throws a MenardError to leave the text unchanged.
	 */
	private write(file: TFile, edit: (text: string) => string): Promise<WriteOutcome> {
		return this.serialize(file.path, async () => {
			let outcome: WriteOutcome = { ok: true, changed: false };
			await this.app.vault.process(file, (text) => {
				try {
					const result = edit(text);
					outcome = { ok: true, changed: result !== text };
					return result;
				} catch (error) {
					if (!isMenardError(error)) throw error;
					outcome = { ok: false, error };
					return text;
				}
			});
			return outcome;
		});
	}

	/** Verifies every `expect` against the current text, then applies the replacements with EOLs normalized. */
	private applyChecked(text: string, replacements: readonly Replacement[]): string {
		const sorted = [...replacements].sort((a, b) => a.from - b.from);
		let previousEnd = 0;
		for (const replacement of sorted) {
			const { from, to, expect } = replacement;
			if (!isOffset(text, from) || !isOffset(text, to) || from < previousEnd || to < from || text.slice(from, to) !== expect) {
				throw new MenardError("write-conflict", "The text to replace is no longer where it was.", expect);
			}
			if (splitsCharacter(text, from) || splitsCharacter(text, to)) {
				throw new MenardError("write-conflict", "A replacement boundary falls inside a line ending or a character.", expect);
			}
			previousEnd = to;
		}
		const eol = eolOf(text);
		return applyReplacements(
			text,
			sorted.map((replacement) => ({ ...replacement, text: withEol(replacement.text, eol) })),
		);
	}

	/** Chains `task` after earlier work on `path`; a failed task does not block later ones. */
	private serialize<T>(path: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(path) ?? Promise.resolve();
		const run = previous.then(task);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(path, tail);
		void tail.then(() => {
			if (this.chains.get(path) === tail) this.chains.delete(path);
		});
		return run;
	}
}

/** The edits a compute function returned; null for "noop"; throws write-conflict for "conflict". */
function computed<T>(result: readonly T[] | "noop" | "conflict", file: TFile): readonly T[] | null {
	if (result === "noop") return null;
	if (result === "conflict") throw new MenardError("write-conflict", `${file.path} changed while writing.`);
	return result;
}

function eolOf(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function withEol(text: string, eol: "\n" | "\r\n"): string {
	return text.replace(/\r?\n/g, eol);
}

/** An integer offset within [0, text.length]. */
function isOffset(text: string, at: number): boolean {
	return Number.isInteger(at) && at >= 0 && at <= text.length;
}

/** True when `at` lies between the `\r` and `\n` of a CRLF, or between the halves of a surrogate pair. */
function splitsCharacter(text: string, at: number): boolean {
	if (at <= 0 || at >= text.length) return false;
	const before = text.charCodeAt(at - 1);
	const next = text.charCodeAt(at);
	const crlf = before === 0x0d && next === 0x0a;
	const surrogates = before >= 0xd800 && before <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
	return crlf || surrogates;
}
