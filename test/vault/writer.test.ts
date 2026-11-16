import { beforeEach, describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { MenardError } from "../../src/errors";
import { VaultBackupStore } from "../../src/vault/backup";
import { SafeWriter } from "../../src/vault/writer";
import type { WriteOutcome } from "../../src/types";
import { createFakeApp, type FakeApp } from "./fake-app";
import {
	MAP_LINE_1,
	SOURCE_PARAGRAPH_1,
	SOURCE_PARAGRAPH_2,
	SOURCE_PATH,
	SOURCE_TEXT,
	TARGET_PARAGRAPH_1,
	TARGET_PATH,
	TARGET_TEXT,
	TRANSLATE_MARKER_1,
	TRANSLATE_MARKER_2,
} from "./fixtures";

function errorCode(outcome: WriteOutcome): string | null {
	return outcome.ok ? null : outcome.error.code;
}

/** Offsets [from, to) of the first occurrence of `needle` in `text`. */
function span(text: string, needle: string): { from: number; to: number } {
	const from = text.indexOf(needle);
	if (from < 0) throw new Error(`"${needle}" not found`);
	return { from, to: from + needle.length };
}

/** Offset just after the end of `needle`. */
function after(text: string, needle: string): number {
	return span(text, needle).to;
}

let fake: FakeApp;
let writer: SafeWriter;
let source: TFile;
let target: TFile;

beforeEach(() => {
	fake = createFakeApp();
	writer = new SafeWriter(fake.app);
	source = fake.vault.seed(SOURCE_PATH, SOURCE_TEXT);
	target = fake.vault.seed(TARGET_PATH, TARGET_TEXT);
});

describe("SafeWriter.insert", () => {
	it("adds block ids to the source's paragraphs and nothing else", async () => {
		const outcome = await writer.insert(source, (text) => [
			{ at: after(text, SOURCE_PARAGRAPH_1), text: " ^p1" },
			{ at: after(text, SOURCE_PARAGRAPH_2), text: " ^p2" },
		]);

		expect(outcome).toEqual({ ok: true, changed: true });
		const result = fake.vault.text(source);
		expect(result).toContain(`${SOURCE_PARAGRAPH_1} ^p1\n`);
		expect(result).toContain(`${SOURCE_PARAGRAPH_2} ^p2\n`);
		expect(result.replace(" ^p1", "").replace(" ^p2", "")).toBe(SOURCE_TEXT);
	});

	it("computes on the current text, not on text read earlier", async () => {
		fake.vault.edit(source, `Nota del lector: «releer».\n\n${SOURCE_TEXT}`);
		await writer.insert(source, (text) => [{ at: after(text, SOURCE_PARAGRAPH_1), text: " ^p1" }]);
		expect(fake.vault.text(source)).toContain(`${SOURCE_PARAGRAPH_1} ^p1`);
		expect(fake.vault.text(source).startsWith("Nota del lector")).toBe(true);
	});

	it("normalizes inserted line breaks to CRLF and keeps every existing CRLF", async () => {
		const crlf = SOURCE_TEXT.replace(/\n/g, "\r\n");
		fake.vault.edit(source, crlf);

		const outcome = await writer.insert(source, (text) => [
			{ at: after(text, SOURCE_PARAGRAPH_1), text: "\n^p1" },
			{ at: after(text, SOURCE_PARAGRAPH_2), text: "\n%%menard:1 p2 align%%" },
		]);

		expect(outcome).toEqual({ ok: true, changed: true });
		const result = fake.vault.text(source);
		expect(result.replace(/\r\n/g, "")).not.toContain("\n");
		expect(result).toContain(`${SOURCE_PARAGRAPH_1}\r\n^p1\r\n`);
		expect(result.replace("\r\n^p1", "").replace("\r\n%%menard:1 p2 align%%", "")).toBe(crlf);
	});

	it("leaves LF files with LF line breaks", async () => {
		await writer.insert(source, (text) => [{ at: after(text, SOURCE_PARAGRAPH_1), text: "\r\n^p1" }]);
		expect(fake.vault.text(source)).toContain(`${SOURCE_PARAGRAPH_1}\n^p1\n`);
		expect(fake.vault.text(source)).not.toContain("\r");
	});

	it("refuses an insertion between the CR and LF of a line ending", async () => {
		const crlf = SOURCE_TEXT.replace(/\n/g, "\r\n");
		fake.vault.edit(source, crlf);

		const outcome = await writer.insert(source, (text) => [{ at: after(text, SOURCE_PARAGRAPH_1) + 1, text: " ^p1" }]);

		expect(errorCode(outcome)).toBe("insert-only-violation");
		expect(fake.vault.text(source)).toBe(crlf);
	});

	it("reports an offset outside the current text as a conflict instead of throwing", async () => {
		for (const at of [-1, SOURCE_TEXT.length + 1, 2.5]) {
			const outcome = await writer.insert(source, () => [{ at, text: " ^p1" }]);
			expect(errorCode(outcome)).toBe("write-conflict");
		}
		expect(fake.vault.text(source)).toBe(SOURCE_TEXT);
	});

	it("refuses an insertion between the halves of a surrogate pair", async () => {
		const withEmoji = `${SOURCE_TEXT}Nota 📖 al margen.\n`;
		fake.vault.edit(source, withEmoji);

		const outcome = await writer.insert(source, (text) => [{ at: text.indexOf("📖") + 1, text: " ^p9" }]);

		expect(errorCode(outcome)).toBe("insert-only-violation");
		expect(fake.vault.text(source)).toBe(withEmoji);
	});

	it("reports noop as unchanged", async () => {
		const outcome = await writer.insert(source, () => "noop");
		expect(outcome).toEqual({ ok: true, changed: false });
		expect(fake.vault.text(source)).toBe(SOURCE_TEXT);
	});

	it("reports an empty list of inserts as unchanged", async () => {
		expect(await writer.insert(source, () => [])).toEqual({ ok: true, changed: false });
	});

	it("leaves the file untouched when compute reports a conflict", async () => {
		const outcome = await writer.insert(source, () => "conflict");
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(SOURCE_TEXT);
	});

	it("lets an unexpected exception from compute propagate without writing", async () => {
		await expect(
			writer.insert(source, () => {
				throw new TypeError("bug in a job");
			}),
		).rejects.toThrow("bug in a job");
		expect(fake.vault.text(source)).toBe(SOURCE_TEXT);
	});

	it("turns a MenardError thrown by compute into a failed outcome", async () => {
		const outcome = await writer.insert(source, () => {
			throw new MenardError("reserved-character", "The note uses ⟦.");
		});
		expect(errorCode(outcome)).toBe("reserved-character");
		expect(fake.vault.text(source)).toBe(SOURCE_TEXT);
	});
});

describe("SafeWriter.rewriteOwned", () => {
	it("replaces a pending marker with its translation", async () => {
		const outcome = await writer.rewriteOwned(target, (text) => [
			{ ...span(text, TRANSLATE_MARKER_1), expect: TRANSLATE_MARKER_1, text: `${TARGET_PARAGRAPH_1}\n${MAP_LINE_1}` },
		]);

		expect(outcome).toEqual({ ok: true, changed: true });
		const result = fake.vault.text(target);
		expect(result).toContain(`# Text\n\n${TARGET_PARAGRAPH_1}\n${MAP_LINE_1}\n\n${TRANSLATE_MARKER_2}\n`);
		expect(result).not.toContain(TRANSLATE_MARKER_1);
	});

	it("rewrites the last line of a file without a final newline", async () => {
		fake.vault.edit(target, TARGET_TEXT.trimEnd());
		const outcome = await writer.rewriteOwned(target, (text) => [
			{ ...span(text, TRANSLATE_MARKER_2), expect: TRANSLATE_MARKER_2, text: "%%menard:1 p2 align%%" },
		]);
		expect(outcome).toEqual({ ok: true, changed: true });
		expect(fake.vault.text(target).endsWith("%%menard:1 p2 align%%")).toBe(true);
	});

	it("refuses to rewrite the user's own prose", async () => {
		fake.vault.edit(target, `${TARGET_TEXT}\n${TARGET_PARAGRAPH_1}\n`);
		const before = fake.vault.text(target);

		const outcome = await writer.rewriteOwned(target, (text) => [
			{ ...span(text, TARGET_PARAGRAPH_1), expect: TARGET_PARAGRAPH_1, text: "Mejorado." },
		]);

		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(before);
	});

	it("refuses a Menard-looking comment inside a line of user text", async () => {
		const line = `Nota: el autor glosa la cita. ${TRANSLATE_MARKER_1}`;
		fake.vault.edit(target, `${TARGET_TEXT}${line}\n`);
		const before = fake.vault.text(target);

		const outcome = await writer.rewriteOwned(target, (text) => {
			const from = text.lastIndexOf(TRANSLATE_MARKER_1);
			return [{ from, to: from + TRANSLATE_MARKER_1.length, expect: TRANSLATE_MARKER_1, text: "" }];
		});

		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(before);
	});

	it("refuses a Menard-looking line inside a user's multi-line %% block (#35)", async () => {
		fake.vault.edit(target, `${TARGET_TEXT}\n%%\nMis notas:\n${TRANSLATE_MARKER_1}\n%%\n`);
		const before = fake.vault.text(target);
		const outcome = await writer.rewriteOwned(target, (text) => {
			const from = text.lastIndexOf(TRANSLATE_MARKER_1);
			return [{ from, to: from + TRANSLATE_MARKER_1.length, expect: TRANSLATE_MARKER_1, text: "" }];
		});
		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(before);
	});

	it("refuses a range that takes the line ending with it", async () => {
		const outcome = await writer.rewriteOwned(target, (text) => {
			const { from, to } = span(text, TRANSLATE_MARKER_1);
			return [{ from, to: to + 1, expect: `${TRANSLATE_MARKER_1}\n`, text: "" }];
		});
		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(TARGET_TEXT);
	});

	it("refuses a Menard line inside a fenced code block, which is the user's text", async () => {
		const fenced = `${TARGET_TEXT}\n~~~markdown\n${MAP_LINE_1}\n~~~\n`;
		fake.vault.edit(target, fenced);

		const outcome = await writer.rewriteOwned(target, (text) => [
			{ from: text.lastIndexOf(MAP_LINE_1), to: text.lastIndexOf(MAP_LINE_1) + MAP_LINE_1.length, expect: MAP_LINE_1, text: "" },
		]);

		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(fenced);
	});

	it("reports a negative offset as a conflict", async () => {
		const outcome = await writer.rewriteOwned(target, (text) => {
			const { from, to } = span(text, TRANSLATE_MARKER_1);
			return [{ from: from - text.length, to, expect: TRANSLATE_MARKER_1, text: "" }];
		});
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(target)).toBe(TARGET_TEXT);
	});

	it("reports a conflict when the Menard line moved", async () => {
		const outcome = await writer.rewriteOwned(target, (text) => {
			const { from, to } = span(text, TRANSLATE_MARKER_1);
			return [{ from: from + 2, to: to + 2, expect: TRANSLATE_MARKER_1, text: MAP_LINE_1 }];
		});
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(target)).toBe(TARGET_TEXT);
	});

	it("applies nothing when one of several replacements is refused", async () => {
		const outcome = await writer.rewriteOwned(target, (text) => [
			{ ...span(text, TRANSLATE_MARKER_1), expect: TRANSLATE_MARKER_1, text: TARGET_PARAGRAPH_1 },
			{ ...span(text, "# Text"), expect: "# Text", text: "# Texto" },
		]);
		expect(errorCode(outcome)).toBe("not-owned");
		expect(fake.vault.text(target)).toBe(TARGET_TEXT);
	});

	it("normalizes the replacement text to the file's CRLF line endings", async () => {
		const crlf = TARGET_TEXT.replace(/\n/g, "\r\n");
		fake.vault.edit(target, crlf);
		await writer.rewriteOwned(target, (text) => [
			{ ...span(text, TRANSLATE_MARKER_1), expect: TRANSLATE_MARKER_1, text: `${TARGET_PARAGRAPH_1}\n${MAP_LINE_1}` },
		]);
		const result = fake.vault.text(target);
		expect(result).toContain(`${TARGET_PARAGRAPH_1}\r\n${MAP_LINE_1}\r\n`);
		expect(result.replace(/\r\n/g, "")).not.toContain("\n");
	});
});

describe("SafeWriter.replace", () => {
	const combined = `${SOURCE_TEXT}\n# English translation\n\n${TARGET_PARAGRAPH_1}\n`;
	let backups: VaultBackupStore;

	beforeEach(() => {
		fake.vault.edit(source, combined);
		backups = new VaultBackupStore(fake.app, () => 30, ".config-dir/plugins/menard", () => new Date(2026, 9, 4, 15, 30, 5));
	});

	it("replaces user text when the backup matches the current content", async () => {
		const token = await backups.save(source);
		const section = `# English translation\n\n${TARGET_PARAGRAPH_1}\n`;

		const outcome = await writer.replace(source, token, (text) => [{ ...span(text, section), expect: section, text: "" }]);

		expect(outcome).toEqual({ ok: true, changed: true });
		expect(fake.vault.text(source)).toBe(`${SOURCE_TEXT}\n`);
	});

	it("refuses a backup taken before the note changed", async () => {
		const token = await backups.save(source);
		fake.vault.edit(source, `${combined}Nota añadida después de la copia.\n`);
		const before = fake.vault.text(source);

		const outcome = await writer.replace(source, token, (text) => [
			{ ...span(text, SOURCE_PARAGRAPH_1), expect: SOURCE_PARAGRAPH_1, text: "" },
		]);

		expect(errorCode(outcome)).toBe("backup-stale");
		expect(fake.vault.text(source)).toBe(before);
	});

	it("refuses a backup of another file", async () => {
		fake.vault.edit(target, combined);
		const token = await backups.save(target);

		const outcome = await writer.replace(source, token, (text) => [
			{ ...span(text, SOURCE_PARAGRAPH_1), expect: SOURCE_PARAGRAPH_1, text: "" },
		]);

		expect(errorCode(outcome)).toBe("backup-stale");
		expect(fake.vault.text(source)).toBe(combined);
	});

	it("refuses a replacement whose expected text differs from the current slice", async () => {
		const token = await backups.save(source);

		const outcome = await writer.replace(source, token, (text) => [
			{ ...span(text, SOURCE_PARAGRAPH_1), expect: SOURCE_PARAGRAPH_1.replace("Sr.", "señor"), text: "" },
		]);

		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(combined);
	});

	it("refuses a boundary between the CR and LF of a line ending", async () => {
		const crlf = combined.replace(/\n/g, "\r\n");
		fake.vault.edit(source, crlf);
		const token = await backups.save(source);

		const outcome = await writer.replace(source, token, (text) => {
			const heading = span(text, "# English translation\r");
			return [{ ...heading, expect: "# English translation\r", text: "# Translation" }];
		});

		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(crlf);
	});

	it("refuses a negative offset even when the slice would match", async () => {
		const token = await backups.save(source);
		const outcome = await writer.replace(source, token, (text) => [
			{ from: -2, to: text.length, expect: text.slice(-2), text: "" },
		]);
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(combined);
	});

	it("refuses overlapping replacements", async () => {
		const token = await backups.save(source);
		const outcome = await writer.replace(source, token, (text) => {
			const { from, to } = span(text, SOURCE_PARAGRAPH_1);
			return [
				{ from, to, expect: SOURCE_PARAGRAPH_1, text: "" },
				{ from: from + 5, to: from + 10, expect: SOURCE_PARAGRAPH_1.slice(5, 10), text: "" },
			];
		});
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(combined);
	});

	it("leaves the file untouched when compute reports a conflict", async () => {
		const token = await backups.save(source);
		const outcome = await writer.replace(source, token, () => "conflict");
		expect(errorCode(outcome)).toBe("write-conflict");
		expect(fake.vault.text(source)).toBe(combined);
	});
});

describe("SafeWriter serialization", () => {
	it("runs concurrent writes to one note one at a time, in call order", async () => {
		const appendLine = (line: string) => (text: string) => [{ at: text.length, text: `${line}\n` }];

		const outcomes = await Promise.all([
			writer.insert(target, appendLine("%%menard:1 p3 translate%%")),
			writer.insert(target, appendLine("%%menard:1 p4 translate%%")),
			writer.insert(target, appendLine("%%menard:1 p5 translate%%")),
		]);

		expect(outcomes.every((outcome) => outcome.ok && outcome.changed)).toBe(true);
		expect(fake.vault.maxConcurrentProcess).toBe(1);
		expect(fake.vault.text(target)).toBe(
			`${TARGET_TEXT}%%menard:1 p3 translate%%\n%%menard:1 p4 translate%%\n%%menard:1 p5 translate%%\n`,
		);
	});

	it("keeps going after a failed write", async () => {
		const results = await Promise.allSettled([
			writer.insert(target, () => {
				throw new Error("boom");
			}),
			writer.insert(target, (text) => [{ at: text.length, text: "%%menard:1 p3 translate%%\n" }]),
		]);
		expect(results[0]?.status).toBe("rejected");
		expect(fake.vault.text(target).endsWith("%%menard:1 p3 translate%%\n")).toBe(true);
	});
});

describe("SafeWriter.create", () => {
	it("creates a note at the normalized path", async () => {
		const file = await writer.create("Collections//Texts/@borgesversiones1932 (EN).md/", "---\n---\n");
		expect(file.path).toBe("Collections/Texts/@borgesversiones1932 (EN).md");
		expect(fake.vault.text(file)).toBe("---\n---\n");
	});

	it("refuses to overwrite an existing note", async () => {
		await expect(writer.create(TARGET_PATH, "nuevo")).rejects.toMatchObject({ code: "file-exists" });
		expect(fake.vault.text(target)).toBe(TARGET_TEXT);
	});
});

describe("SafeWriter.setFrontmatter", () => {
	it("sets only the given keys", async () => {
		fake.metadataCache.frontmatter.set(source.path, {
			citekey: "ruizalmotasim",
			tags: ["borges", "metalepsis"],
			course: ["[[SPAN 194]]"],
		});

		await writer.setFrontmatter(source, { translation: "[[@ruizalmotasim (EN)]]" });

		expect(fake.metadataCache.frontmatter.get(source.path)).toEqual({
			citekey: "ruizalmotasim",
			tags: ["borges", "metalepsis"],
			course: ["[[SPAN 194]]"],
			translation: "[[@ruizalmotasim (EN)]]",
		});
	});
});

describe("SafeWriter.trashCreated", () => {
	it("moves the note to the trash through the file manager", async () => {
		await writer.trashCreated(target);
		expect(fake.fileManager.trashed).toEqual([TARGET_PATH]);
		expect(fake.vault.getFileByPath(TARGET_PATH)).toBeNull();
	});
});
