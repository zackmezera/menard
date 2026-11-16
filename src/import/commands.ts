/**
 * The import commands: EPUB → chapter notes, print page markers from a PDF,
 * PDF text → a note, and PDF pages → a pair (then Align or Translate). Modals, file reading and vault writes; the logic lives
 * in the pure modules beside this one. Nothing leaves the machine. Owner:
 * import module. DESIGN.md §16.
 */
import { Modal, Notice, Platform, TFile, htmlToMarkdown, loadPdfJs, normalizePath } from "obsidian";
import type { App, Plugin } from "obsidian";
import { canonicalLanguage } from "../jobs/modals";
import { FM } from "../constants";
import type { JobsApi, MenardSettings, NoteWriter } from "../types";
import { translationPath, wikilinkValue } from "../vault/properties";
import { chapterBasename, chapterNote, findExistingBook, hubNote, readEpub, sourceEdition, suggestCitekey } from "./epub";
import type { BookPlan } from "./epub";
import { placePageMarkers } from "./pages";
import { pageOpenings, pdfToMarkdown, readPdfPages } from "./pdf";
import type { PdfJsDocument, PdfPage } from "./pdf";
import { openZip } from "./zip";

export function registerImportCommands(plugin: Plugin, writer: NoteWriter, settings: () => MenardSettings, jobs: Pick<JobsApi, "align" | "translate">): void {
	const { app } = plugin;
	const guard = (run: () => Promise<void>) => () => {
		run().catch((error: unknown) => report(app, "Import failed", [error instanceof Error ? error.message : String(error)]));
	};
	plugin.addCommand({ id: "import-epub", name: "Import EPUB as chapter notes", callback: guard(() => importEpub(app, writer, settings())) });
	plugin.addCommand({ id: "import-pdf-text", name: "Import PDF text as a note", callback: guard(() => importPdfText(app, writer)) });
	plugin.addCommand({ id: "import-pdf-pair", name: "Import a chapter pair from PDF…", callback: guard(() => importPdfPair(app, writer, settings(), jobs)) });
	plugin.addCommand({
		id: "add-pdf-page-markers",
		name: "Add print page markers from PDF…",
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (file?.extension !== "md") return false;
			if (!checking) guard(() => addPageMarkers(app, writer, file))();
			return true;
		},
	});
}

// ---------------------------------------------------------------- EPUB

async function importEpub(app: App, writer: NoteWriter, settings: MenardSettings): Promise<void> {
	const source = await form(app, "Import EPUB as chapter notes", [fileField("file", "EPUB file", ".epub")], "Next");
	if (!source) return;
	const { bytes } = await readSource(app, source.values.file!, source.files.file);
	const plan = await readEpub(openZip(bytes), (element) => htmlToMarkdown(element));
	if (plan.chapters.length === 0) throw new Error("No chapters with text were found in this EPUB.");

	const active = app.workspace.getActiveFile();
	const existing = findExistingBook(
		plan.meta,
		app.vault.getMarkdownFiles().map((f) => ({ basename: f.basename, folder: f.parent?.path ?? "", aliases: aliasesOf(app, f) })),
	);
	const answers = await form(
		app,
		"Import EPUB as chapter notes",
		[
			{ key: "citekey", label: "Citekey", value: existing?.citekey ?? suggestCitekey(plan.meta) },
			{ key: "language", label: "Source language", value: canonicalLanguage(plan.meta.language) ?? settings.defaultSourceLanguage },
			{ key: "folder", label: "Folder", value: existing?.folder ?? bookParent(active?.parent ?? null), desc: "The book's folder is made inside this one. Empty for the vault root." },
		],
		"Import",
		[
			`“${plan.meta.title}”: ${plan.chapters.length} chapter notes.`,
			...(existing ? [`Using the existing note @${existing.citekey} for this book.`] : []),
			...(plan.skipped.length > 0 ? [`Skipped: ${plan.skipped.map((s) => `${baseName(s.file)} (${s.reason})`).join(", ")}.`] : []),
		],
	);
	if (!answers) return;
	const citekey = answers.values.citekey!.trim();
	const language = canonicalLanguage(answers.values.language!);
	if (!/^[\p{L}\p{N}_:.-]+$/u.test(citekey)) throw new Error("A citekey may hold letters, digits and _ : . - only.");
	if (language === null) throw new Error(`“${answers.values.language}” is not a language tag such as es or en.`);
	const folder = normalizePath(answers.values.folder!.trim() || "/");
	await writeBook(app, writer, plan, { citekey, language, folder: folder === "/" ? "" : folder });
}

async function writeBook(app: App, writer: NoteWriter, plan: BookPlan, options: { citekey: string; language: string; folder: string }): Promise<void> {
	const { citekey, language, folder } = options;
	const prefix = folder === "" ? "" : `${folder}/`;
	const bookFolder = `${prefix}@${citekey}`;
	const width = Math.max(2, String(plan.chapters.length).length);
	const notes = plan.chapters.map((chapter) => ({ chapter, basename: chapterBasename(chapter, width) }));
	const taken = notes.map((note) => `${bookFolder}/${note.basename}.md`).filter((path) => app.vault.getAbstractFileByPath(path));
	if (taken.length > 0) throw new Error(`Nothing was written: these notes already exist: ${taken.join(", ")}.`);

	for (const path of [prefix.replace(/\/$/, ""), bookFolder]) {
		if (path !== "" && !app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
	}
	const edition = sourceEdition(plan.meta);
	for (const { chapter, basename } of notes) {
		await writer.create(`${bookFolder}/${basename}.md`, chapterNote(chapter, { citekey, language, edition }));
	}
	const links = notes.map((note) => `[[@${citekey}/${note.basename}|${note.basename}]]`);
	const hubPath = `${prefix}@${citekey}.md`;
	const hub = app.vault.getAbstractFileByPath(hubPath);
	let hubLine = `Hub note: ${hubPath}.`;
	let leftover: string | undefined;
	if (hub === null) await writer.create(hubPath, hubNote(plan.meta, citekey, links));
	else if (hub instanceof TFile) {
		const outcome = await writer.insert(hub, (text) => chaptersSection(text, links));
		if (!outcome.ok) throw outcome.error;
		if (outcome.changed) hubLine = `Added a Chapters section to ${hubPath}.`;
		else {
			hubLine = `${hubPath} already has a Chapters section and was left alone. The links, to add by hand:`;
			leftover = links.map((link) => `- ${link}`).join("\n");
		}
	}

	report(
		app,
		"EPUB imported",
		[
			`${notes.length} chapter notes in ${bookFolder}.`,
			...notes.map(({ chapter, basename }) => `${basename}: ${chapter.words} words, ${chapter.footnotes} footnotes${chapter.pageMarkers > 0 ? `, ${chapter.pageMarkers} page markers` : ""}`),
			...plan.skipped.map((s) => `Skipped ${baseName(s.file)}: ${s.reason}, ${s.words} words.`),
			hubLine,
		],
		leftover,
	);
}

/**
 * Adds a "## Chapters" list to an existing book note, before the first `---`
 * divider of the body (where the note's own sections begin), else at the end.
 * A note that already has a Chapters heading is left alone. Insert-only.
 */
export function chaptersSection(text: string, links: readonly string[]): { at: number; text: string }[] | "noop" {
	if (/^#{1,6}\s+chapters\s*$/im.test(text)) return "noop";
	const list = `## Chapters\n\n${links.map((link) => `- ${link}`).join("\n")}\n`;
	const bodyStart = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) + 5 : 0;
	const divider = bodyStart >= 5 || bodyStart === 0 ? text.slice(bodyStart).search(/^---[ \t]*$/m) : -1;
	if (divider > 0) return [{ at: bodyStart + divider, text: `${list}\n` }];
	const lead = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return [{ at: text.length, text: `${lead}${list}` }];
}

// ---------------------------------------------------------------- PDF

/** Page range fields; `prefix` keeps two PDFs' fields apart in one form. */
function pdfFields(prefix = "", what = "PDF"): Field[] {
	return [
		{ key: `${prefix}first`, label: `First ${what} page`, value: "1" },
		{ key: `${prefix}last`, label: `Last ${what} page`, value: "", desc: "Empty for the last page." },
		{ key: `${prefix}offset`, label: "Page offset", value: "0", desc: "Printed page = PDF page + offset. Used only when the PDF has no page labels." },
	];
}
const PDF_FIELDS = pdfFields();

async function addPageMarkers(app: App, writer: NoteWriter, active: TFile): Promise<void> {
	const answers = await form(
		app,
		"Add print page markers from PDF",
		[fileField("file", "PDF", ".pdf"), ...PDF_FIELDS, { key: "folder", label: "Every note in this folder", value: "", toggle: true }],
		"Add markers",
		["Markers are only inserted; no text changes. Existing markers stay where they are."],
	);
	if (!answers) return;
	const { pages, name } = await loadPages(app, answers);
	const files =
		answers.values.folder === "true"
			? app.vault
					.getMarkdownFiles()
					.filter((file) => file.parent === active.parent)
					.sort((a, b) => a.path.localeCompare(b.path))
			: [active];
	let remaining = pageOpenings(pages, labelFor(answers));
	const lines: string[] = [];
	for (const file of files) {
		let result: ReturnType<typeof placePageMarkers> | null = null;
		const outcome = await writer.insert(file, (text) => {
			result = placePageMarkers(text, remaining);
			return result.inserts.length > 0 ? result.inserts : "noop";
		});
		const placed = (result as ReturnType<typeof placePageMarkers> | null)?.placed ?? [];
		if (!outcome.ok) {
			lines.push(`${file.basename}: not written (${outcome.error.message})`);
			continue;
		}
		if (placed.length > 0) {
			await writer.setFrontmatter(file, { pageSource: "pdf-matched", pageSourceFile: name });
			// Later notes only look at pages after the last one placed here.
			const last = remaining.findIndex((page) => page.label === placed[placed.length - 1]!.label);
			remaining = remaining.slice(last + 1);
		}
		lines.push(`${file.basename}: ${placed.length} placed (${ranges(placed.map((p) => p.label))}).`);
	}
	const unplaced = remaining.length;
	report(app, "Print page markers", [...lines, `${unplaced} PDF ${unplaced === 1 ? "page was" : "pages were"} not placed after the last marker.`]);
}

async function importPdfText(app: App, writer: NoteWriter): Promise<void> {
	const active = app.workspace.getActiveFile();
	const answers = await form(
		app,
		"Import PDF text as a note",
		[
			fileField("file", "PDF", ".pdf"),
			...PDF_FIELDS,
			{ key: "name", label: "Note name", value: "", desc: "Empty for the PDF's name and page range." },
			{ key: "folder", label: "Folder", value: folderOf(active), desc: "Empty for the vault root." },
		],
		"Import",
	);
	if (!answers) return;
	const { pages, name } = await loadPages(app, answers);
	if (pages.length === 0) throw new Error("That page range holds no pages.");
	const label = labelFor(answers);
	const body = pdfToMarkdown(pages, { label: (page) => label(page) });
	if (body.replace(/%%[^%]*%%/g, "").trim() === "") throw new Error("Those pages have no text layer; run OCR on the PDF first.");
	const title = answers.values.name!.trim() || `${name.replace(/\.pdf$/i, "")} pp. ${label(pages[0]!)}–${label(pages[pages.length - 1]!)}`;
	const folder = normalizePath(answers.values.folder!.trim() || "/");
	const path = `${folder === "/" ? "" : `${folder}/`}${safeName(title)}.md`;
	const file = await writer.create(path, ["---", "pageSource: pdf-text", `pageSourceFile: ${JSON.stringify(name)}`, "---", "", body, ""].join("\n"));
	await app.workspace.getLeaf(false).openFile(file);
	new Notice(`Imported ${pages.length} pages into ${file.basename}.`);
}

/**
 * A pair from PDF pages: the source from a PDF range or the active note
 * (e.g. a chapter imported from EPUB), the translation optionally from
 * another PDF range. Writes `NN Title.md` and `NN Title (EN).md` linked by
 * frontmatter, then offers Align (with a translation) or Translate.
 */
async function importPdfPair(app: App, writer: NoteWriter, settings: MenardSettings, jobs: Pick<JobsApi, "align" | "translate">): Promise<void> {
	const active = app.workspace.getActiveFile();
	const activeNote = active?.extension === "md" ? active : null;
	const declared: unknown = activeNote ? app.metadataCache.getFileCache(activeNote)?.frontmatter?.originalLanguage : undefined;
	const answers = await form(
		app,
		"Import a chapter pair from PDF",
		[
			{ ...fileField("file", "Source PDF", ".pdf"), desc: `Empty to use the open note${activeNote ? ` (${activeNote.basename})` : ""} as the source.` },
			...pdfFields("", "source"),
			{ ...fileField("tfile", "Translation PDF", ".pdf"), desc: "Empty to translate the source with Claude instead." },
			...pdfFields("t", "translation"),
			{ key: "name", label: "Note name", value: "", desc: "For example 07 The Buried Foundation; empty for the PDF name and pages. Ignored when the open note is the source." },
			{ key: "folder", label: "Folder", value: folderOf(activeNote), desc: "Empty for the vault root. Ignored when the open note is the source." },
			{ key: "source", label: "Source language", value: (typeof declared === "string" ? canonicalLanguage(declared) : null) ?? settings.defaultSourceLanguage },
			{ key: "target", label: "Target language", value: settings.defaultTargetLanguage },
		],
		"Import",
	);
	if (!answers) return;
	const v = answers.values;
	const fromPdf = v.file!.trim() !== "" || answers.files.file !== undefined;
	const withTranslation = v.tfile!.trim() !== "" || answers.files.tfile !== undefined;
	const languages = { source: canonicalLanguage(v.source!), target: canonicalLanguage(v.target!) };
	if (languages.source === null || languages.target === null) throw new Error("The languages must be tags such as es or en.");
	if (!fromPdf && !activeNote) throw new Error("Choose a source PDF, or open the note to use as the source.");

	// Everything is read and checked before anything is written.
	let sourcePath = activeNote?.path ?? "";
	let sourceText: string | null = null;
	if (fromPdf) {
		const { pages, name } = await loadPages(app, answers);
		const label = labelFor(answers);
		const body = pdfToMarkdown(pages, { label: (page) => label(page) });
		if (pages.length === 0 || body.replace(/%%[^%]*%%/g, "").trim() === "") throw new Error("The source pages have no text; run OCR on the PDF first.");
		const title = v.name!.trim() || `${name.replace(/\.pdf$/i, "")} pp. ${label(pages[0]!)}–${label(pages[pages.length - 1]!)}`;
		const folder = normalizePath(v.folder!.trim() || "/");
		sourcePath = `${folder === "/" ? "" : `${folder}/`}${safeName(title)}.md`;
		sourceText = pdfNote({ originalLanguage: languages.source, sourceEdition: edition(name, pages, label), pageSource: "pdf-text", pageSourceFile: name }, body);
		if (app.vault.getAbstractFileByPath(sourcePath)) throw new Error(`Nothing was written: ${sourcePath} already exists.`);
	} else if (app.metadataCache.getFileCache(activeNote!)?.frontmatter?.[FM.translation] !== undefined) {
		throw new Error(`${activeNote!.basename} already has a translation; run Align or Translate on it instead.`);
	}
	const targetPath = translationPath(sourcePath, languages.target);
	let targetBody: { text: string; pages: number; edition: string; file: string } | null = null;
	if (withTranslation) {
		const { pages, name } = await loadPages(app, answers, "t");
		const label = labelFor(answers, "t");
		const text = pdfToMarkdown(pages, { label: (page) => label(page) });
		if (pages.length === 0 || text.replace(/%%[^%]*%%/g, "").trim() === "") throw new Error("The translation pages have no text; run OCR on the PDF first.");
		targetBody = { text, pages: pages.length, edition: edition(name, pages, label), file: name };
		if (app.vault.getAbstractFileByPath(targetPath)) throw new Error(`Nothing was written: ${targetPath} already exists.`);
	}

	if (sourceText !== null) {
		const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
		if (parent !== "" && !app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
	}
	const source = sourceText !== null ? await writer.create(sourcePath, sourceText) : activeNote!;
	if (targetBody === null) {
		await app.workspace.getLeaf(false).openFile(source);
		if (await offer(app, `Created ${source.basename}.`, "Translate now", "Translate note writes the translation with Claude.")) await jobs.translate(source);
		return;
	}
	const target = await writer.create(
		targetPath,
		pdfNote(
			{
				[FM.source]: wikilinkValue(app.metadataCache.fileToLinktext(source, targetPath)),
				[FM.sourceLanguage]: languages.source,
				[FM.targetLanguage]: languages.target,
				sourceEdition: targetBody.edition,
				pageSource: "pdf-text",
				pageSourceFile: targetBody.file,
			},
			targetBody.text,
		),
	);
	await writer.setFrontmatter(source, { [FM.translation]: wikilinkValue(app.metadataCache.fileToLinktext(target, source.path)) });
	await app.workspace.getLeaf(false).openFile(source);
	const made = sourceText !== null ? `${source.basename} and ${target.basename}` : target.basename;
	if (await offer(app, `Created ${made} (${targetBody.pages} translation pages).`, "Align now", "Align pairs their paragraphs and sentences with Claude.")) await jobs.align(source);
}

/** A note from PDF text: string properties as YAML, then the body. */
export function pdfNote(properties: Record<string, string>, body: string): string {
	return ["---", ...Object.entries(properties).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", "", body, ""].join("\n");
}

/** "Book, pp. 112–129" from a PDF's name and the labels of its first and last page. */
export function edition(file: string, pages: readonly PdfPage[], label: (page: PdfPage) => string): string {
	const first = label(pages[0]!);
	const last = label(pages[pages.length - 1]!);
	return `${file.replace(/\.pdf$/i, "")}, ${first === last ? `p. ${first}` : `pp. ${first}–${last}`}`;
}

function safeName(title: string): string {
	return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function folderOf(file: TFile | null): string {
	return file?.parent?.path === "/" ? "" : (file?.parent?.path ?? "");
}

async function offer(app: App, done: string, action: string, what: string): Promise<boolean> {
	return (await form(app, "Pair imported", [], action, [done, what])) !== null;
}

async function loadPages(app: App, answers: FormResult, prefix = ""): Promise<{ pages: PdfPage[]; name: string }> {
	const { bytes, name } = await readSource(app, answers.values[`${prefix}file`]!, answers.files[`${prefix}file`]);
	const pdfjs = (await loadPdfJs()) as { getDocument(options: { data: Uint8Array }): { promise: Promise<PdfJsDocument & { destroy(): Promise<void> }> } };
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	try {
		const first = Number(answers.values[`${prefix}first`]) || 1;
		const last = Number(answers.values[`${prefix}last`]) || doc.numPages;
		return { pages: await readPdfPages(doc, first, last), name };
	} finally {
		void doc.destroy();
	}
}

function labelFor(answers: FormResult, prefix = ""): (page: PdfPage) => string {
	const offset = Number(answers.values[`${prefix}offset`]) || 0;
	return (page) => page.label ?? String(page.index + offset);
}

// ---------------------------------------------------------------- files

/** Bytes from a picked file, a vault path, or (desktop) an absolute path. */
async function readSource(app: App, value: string, picked: File | undefined): Promise<{ bytes: Uint8Array; name: string }> {
	if (picked) return { bytes: new Uint8Array(await picked.arrayBuffer()), name: picked.name };
	const input = value.trim();
	if (input === "") throw new Error("Choose a file or type its path.");
	const inVault = app.vault.getAbstractFileByPath(normalizePath(input));
	if (inVault instanceof TFile) return { bytes: new Uint8Array(await app.vault.readBinary(inVault)), name: inVault.name };
	if (Platform.isDesktopApp && /^(\/|~\/|[A-Za-z]:[\\/])/.test(input)) {
		/* eslint-disable @typescript-eslint/no-require-imports -- Node built-ins load lazily, after the Platform.isDesktopApp guard (DESIGN.md §3.1). */
		const fs = require("fs") as typeof import("fs");
		const os = require("os") as typeof import("os");
		/* eslint-enable @typescript-eslint/no-require-imports -- end of the guarded block. */
		const path = input.replace(/^~(?=\/)/, os.homedir());
		return { bytes: new Uint8Array(await fs.promises.readFile(path)), name: path.split(/[\\/]/).pop() ?? path };
	}
	throw new Error(`${input} is not a file in this vault${Platform.isDesktopApp ? " or an absolute path" : ""}.`);
}

function baseName(path: string): string {
	return path.split("/").pop() ?? path;
}

/** "12–15, 18" from labels in order. */
export function ranges(labels: readonly string[]): string {
	const parts: string[] = [];
	for (const label of labels) {
		const last = parts[parts.length - 1];
		const match = last ? /^(\d+)(?:–(\d+))?$/.exec(last) : null;
		const end = match ? Number(match[2] ?? match[1]) : NaN;
		if (match && Number(label) === end + 1) parts[parts.length - 1] = `${match[1]}–${label}`;
		else parts.push(label);
	}
	return parts.join(", ") || "none";
}

// ---------------------------------------------------------------- modals

interface Field {
	key: string;
	label: string;
	value: string;
	desc?: string;
	/** Adds a Choose button backed by a native file input. */
	accept?: string;
	toggle?: boolean;
}

interface FormResult {
	values: Record<string, string>;
	files: Record<string, File | undefined>;
}

function fileField(key: string, label: string, accept: string): Field {
	return {
		key,
		label,
		value: "",
		accept,
		desc: Platform.isDesktopApp ? "Choose a file, or type a vault path or an absolute path." : "Choose a file, or type a vault path.",
	};
}

function form(app: App, title: string, fields: Field[], action: string, lines: string[] = []): Promise<FormResult | null> {
	return new Promise((resolve) => new FormModal(app, title, fields, action, lines, resolve).open());
}

function report(app: App, title: string, lines: string[], copy?: string): void {
	new ReportModal(app, title, lines, copy).open();
}

class FormModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly fields: Field[],
		private readonly action: string,
		private readonly lines: string[],
		private readonly resolve: (result: FormResult | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.heading);
		for (const line of this.lines) contentEl.createEl("p", { text: line });
		const inputs = new Map<string, HTMLInputElement>();
		const files: Record<string, File | undefined> = {};
		for (const field of this.fields) {
			const row = contentEl.createDiv({ cls: "setting-item" });
			const info = row.createDiv({ cls: "setting-item-info" });
			info.createDiv({ cls: "setting-item-name", text: field.label });
			if (field.desc !== undefined) info.createDiv({ cls: "setting-item-description", text: field.desc });
			const control = row.createDiv({ cls: "setting-item-control" });
			const input = control.createEl("input", { type: field.toggle === true ? "checkbox" : "text", value: field.value });
			inputs.set(field.key, input);
			if (field.accept !== undefined) {
				const picker = control.createEl("input", { type: "file", attr: { accept: field.accept, hidden: "" } });
				control.createEl("button", { text: "Choose…" }).addEventListener("click", () => picker.click());
				picker.addEventListener("change", () => {
					files[field.key] = picker.files?.[0];
					input.value = files[field.key]?.name ?? "";
				});
				input.addEventListener("input", () => (files[field.key] = undefined));
			}
		}
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: this.action, cls: "mod-cta" }).addEventListener("click", () => {
			const values: Record<string, string> = {};
			for (const [key, input] of inputs) values[key] = input.type === "checkbox" ? String(input.checked) : input.value;
			this.answered = true;
			this.resolve({ values, files });
			this.close();
		});
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(null);
	}
}

class ReportModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly lines: string[],
		private readonly copy?: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(this.heading);
		const list = this.contentEl.createEl("ul");
		for (const line of this.lines) list.createEl("li", { text: line });
		if (this.copy !== undefined) {
			this.contentEl.createEl("textarea", { text: this.copy, cls: "menard-import-links", attr: { rows: "8", readonly: "" } });
			this.contentEl.createDiv({ cls: "modal-button-container" }).createEl("button", { text: "Copy links", cls: "mod-cta" }).addEventListener("click", () => {
				void navigator.clipboard.writeText(this.copy ?? "").then(() => new Notice("Links copied."));
			});
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** Where a new book folder goes: the active note's folder, or above it when that is itself a book folder (`@citekey`). */
export function bookParent(folder: { name: string; path: string; parent: unknown } | null): string {
	let current = folder;
	while (current && current.name.startsWith("@")) current = current.parent as typeof folder;
	return !current || current.path === "/" ? "" : current.path;
}

function aliasesOf(app: App, file: TFile): string[] {
	const raw: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
	return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : typeof raw === "string" ? [raw] : [];
}
