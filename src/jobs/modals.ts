/**
 * Confirmation, preview and picker modals for jobs, and the JobUi seam
 * through which jobs reach them. Owner: jobs module. DESIGN.md §7, §11.
 */
import { FuzzySuggestModal, Modal, Notice } from "obsidian";
import type { App, TFile } from "obsidian";
import type { PairLanguages } from "../types";
import type { BatchItem, BatchPreflight } from "./batch";
import type { PairReport } from "./check";
import type { JobDeps } from "./controller";
import { languageName, sameLanguage } from "./language";
import { ProgressNotice } from "./progress";
import type { ProgressSink } from "./progress";
import type { SplitPlan } from "./split-plan";

/** The network disclosure shown before any text leaves the vault. */
export const DISCLOSURE = "The text of this note will be sent to Anthropic through your local Claude Code installation.";

export interface PreflightInfo {
	sourceName: string;
	languages: PairLanguages;
	model: string;
	units: number;
	idsToAdd: number;
	skippedSections: string[];
	/** The start of the first text unit, so the reader sees where the text begins (#26). */
	firstUnit?: string;
	/** The language the text looks like, when a guess could be made (#25). */
	guessedSource?: string;
	/** Rough duration in minutes at the configured concurrency. */
	estimatedMinutes: number;
	resume: boolean;
}

/** What the Split confirmation shows and asks (#25, #31). */
export interface SplitPreflight {
	plan: SplitPlan;
	/** Proposed languages; the user confirms or edits them. */
	languages: PairLanguages;
	/** The new translation note's path for a target language. */
	translationPath: (target: string) => string;
	/** The language the source text looks like, when a guess could be made. */
	guessedSource?: string;
	/** The language the translation text looks like, when a guess could be made. */
	guessedTarget?: string;
}

export interface AlignSummary {
	sections: number;
	paired: number;
	sourceOnly: number;
	targetOnly: number;
	/** First words of each doubtful pair, "source / translation". */
	doubtful: string[];
	/** First words of each merged pair (ADR 0010), "source + source / translation". */
	merged: string[];
}

/** The report's buttons; absent actions are not shown. */
export interface ReportActions {
	refresh?: () => void;
	realign?: () => void;
	repairLink?: () => void;
	resume?: () => void;
}

/** Everything a job shows the user. Obsidian modals in the app; scripted fakes in tests. */
export interface JobUi {
	/** Resolves the confirmed languages, or null on cancel. */
	confirmTranslate(info: PreflightInfo): Promise<PairLanguages | null>;
	confirmAlign(summary: AlignSummary): Promise<boolean>;
	/** Resolves the confirmed languages, or null on cancel. */
	confirmSplit(info: SplitPreflight): Promise<PairLanguages | null>;
	/** Resolves the confirmed languages for a folder batch, or null on cancel. */
	confirmBatch(info: BatchPreflight): Promise<PairLanguages | null>;
	confirmReplaceEdited(preview: string): Promise<boolean>;
	pickNote(exclude: TFile): Promise<TFile | null>;
	showReport(report: PairReport, actions: ReportActions): void;
	/** A modal explaining why nothing was done. */
	explain(title: string, message: string): void;
	notice(message: string): void;
	progress(title: string, onCancel: () => void): ProgressSink;
}

/** The injected UI, or Obsidian's. */
export function uiOf(deps: JobDeps): JobUi {
	return deps.ui ?? obsidianUi(deps.ctx.app, deps.statusBar ?? null);
}

export function obsidianUi(app: App, statusBar: HTMLElement | null): JobUi {
	return {
		confirmTranslate: (info) => confirmTranslate(app, info),
		confirmAlign: (summary) => confirmAlign(app, summary),
		confirmSplit: (info) => confirmSplit(app, info),
		confirmBatch: (info) => confirmBatch(app, info),
		confirmReplaceEdited: (preview) => confirmReplaceEdited(app, preview),
		pickNote: (exclude) => pickNote(app, exclude),
		showReport: (report, actions) => showReport(app, report, actions),
		explain: (title, message) => new MessageModal(app, title, message).open(),
		notice: (message) => {
			new Notice(message);
		},
		progress: (title, onCancel) => new ProgressNotice(title, onCancel, statusBar),
	};
}

/** Resolves the confirmed languages, or null on cancel. Shows the network disclosure. */
export function confirmTranslate(app: App, info: PreflightInfo): Promise<PairLanguages | null> {
	return new Promise((resolve) => new TranslateModal(app, info, resolve).open());
}

export function confirmAlign(app: App, summary: AlignSummary): Promise<boolean> {
	const lines = [
		`${summary.sections} ${plural(summary.sections, "section")}: ${summary.paired} paired, ${summary.sourceOnly} only in the source, ${summary.targetOnly} only in the translation.`,
		"No word of either note changes. Menard adds paragraph ids and sentence maps.",
		DISCLOSURE,
	];
	return confirm(app, "Align with existing translation", lines, "Align", [
		{ label: "Read as one paragraph:", items: summary.merged },
		{ label: "Check these pairs:", items: summary.doubtful },
	]);
}

/** Resolves the confirmed languages, or null on cancel. */
export function confirmSplit(app: App, info: SplitPreflight): Promise<PairLanguages | null> {
	return new Promise((resolve) => new SplitModal(app, info, resolve).open());
}

/** Resolves the confirmed languages for a folder batch, or null on cancel. Shows the network disclosure. */
export function confirmBatch(app: App, info: BatchPreflight): Promise<PairLanguages | null> {
	return new Promise((resolve) => new BatchModal(app, info, resolve).open());
}

const BATCH_VERBS: Record<BatchItem["action"], string> = {
	translate: "translate",
	resume: "resume translation",
	align: "align",
	done: "already done, skipped",
};

/** One line per note of a folder batch: "@x: align with “@x (EN)”, about 12 calls". */
export function batchLines(items: readonly BatchItem[]): string[] {
	return items.map((item) => {
		const partner = item.action === "align" && item.target !== null ? ` with “${item.target.basename}”` : "";
		const calls = item.action === "done" ? "" : `, about ${item.calls} ${plural(item.calls, "call")}`;
		return `${item.file.basename}: ${BATCH_VERBS[item.action]}${partner}${calls}`;
	});
}

/** The lines of the Split confirmation that do not depend on the languages. */
export function splitLines(plan: SplitPlan): string[] {
	const renamed = Object.entries(plan.renamedFootnotes);
	const copied = plan.copiedFootnotes;
	return [
		`Move ${plan.movedBlocks} ${plural(plan.movedBlocks, "block")} and ${plan.movedFootnotes} ${plural(plan.movedFootnotes, "footnote")} into the new translation note.`,
		...(copied > 0 ? [`Copy ${copied} ${plural(copied, "footnote")} both texts cite; ${copied === 1 ? "it stays" : "they stay"} in the source too.`] : []),
		...(renamed.length > 0 ? [`Rename footnotes ${renamed.slice(0, 3).map(([from, to]) => `[^${from}] to [^${to}]`).join(", ")}${renamed.length > 3 ? ", …" : ""}.`] : []),
		"A backup of the original is saved. The two notes are then aligned.",
	];
}

/** "This paragraph was edited after translation. Replace it? A backup is saved." */
export function confirmReplaceEdited(app: App, preview: string): Promise<boolean> {
	return confirm(app, "Replace edited translation", ["This paragraph was edited after translation. Replace it? A backup is saved."], "Replace", [{ items: [preview] }]);
}

/** Picks the translation note for Align; resolves null on dismiss. */
export function pickNote(app: App, exclude: TFile): Promise<TFile | null> {
	return new Promise((resolve) => new NotePicker(app, exclude, resolve).open());
}

/** Shows a PairReport with Refresh and Realign actions. */
export function showReport(app: App, report: PairReport, actions: ReportActions): void {
	new ReportModal(app, report, actions).open();
}

/** A list under the modal's lines, with an optional label paragraph above it; an empty list is not shown. */
export interface DetailList {
	label?: string;
	items: readonly string[];
}

function confirm(app: App, title: string, lines: readonly string[], action: string, details: readonly DetailList[] = []): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, lines, details, action, resolve).open());
}

/**
 * The canonical BCP 47 tag typed in `input` ("ES" gives "es"), or null after
 * marking the field invalid when it is empty or not a language tag.
 */
export function languageCode(input: HTMLInputElement): string | null {
	const code = canonicalLanguage(input.value);
	input.setAttribute("aria-invalid", String(code === null));
	return code;
}

/** `value` as a canonical BCP 47 tag, or null. */
export function canonicalLanguage(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	try {
		return Intl.getCanonicalLocales(trimmed)[0] ?? null;
	} catch {
		return null;
	}
}

function plural(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

/** Adds a right-aligned row of buttons; the first is the call to action. */
function buttonRow(parent: HTMLElement, buttons: readonly { text: string; cta?: boolean; onClick: () => void }[]): void {
	const row = parent.createDiv({ cls: "modal-button-container" });
	for (const button of buttons) {
		const el = row.createEl("button", { text: button.text, cls: button.cta === true ? "mod-cta" : "" });
		el.addEventListener("click", button.onClick);
	}
}

class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly lines: readonly string[],
		private readonly details: readonly DetailList[],
		private readonly action: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(this.heading);
		for (const line of this.lines) this.contentEl.createEl("p", { text: line });
		for (const detail of this.details) {
			if (detail.items.length === 0) continue;
			if (detail.label !== undefined) this.contentEl.createEl("p", { text: detail.label });
			const list = this.contentEl.createEl("ul");
			for (const item of detail.items) list.createEl("li", { text: item });
		}
		buttonRow(this.contentEl, [
			{ text: this.action, cta: true, onClick: () => this.answer(true) },
			{ text: "Cancel", onClick: () => this.answer(false) },
		]);
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(false);
	}

	private answer(confirmed: boolean): void {
		this.answered = true;
		this.resolve(confirmed);
		this.close();
	}
}

class TranslateModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly info: PreflightInfo,
		private readonly resolve: (languages: PairLanguages | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { info, contentEl } = this;
		this.modalEl.addClass("menard-preflight");
		this.setTitle(info.resume ? "Resume translation" : "Translate note");
		const work = info.resume
			? `${info.units} ${plural(info.units, "unit")} of “${info.sourceName}” still to translate.`
			: `Translate ${info.units} ${plural(info.units, "unit")} of “${info.sourceName}”.`;
		contentEl.createEl("p", { text: work });
		const fields = new LanguageFields(contentEl, info.languages, info.resume, { source: info.guessedSource });
		const facts = contentEl.createEl("ul");
		facts.createEl("li", { text: `Model: ${info.model}` });
		if (info.idsToAdd > 0) facts.createEl("li", { text: `Paragraph ids to add to the source: ${info.idsToAdd}` });
		if (info.firstUnit !== undefined) facts.createEl("li", { text: `Text starts with: “${info.firstUnit}”` });
		if (info.skippedSections.length > 0) facts.createEl("li", { text: `Skipped sections: ${info.skippedSections.join(", ")}` });
		facts.createEl("li", { text: `Estimated time: about ${Math.max(1, Math.round(info.estimatedMinutes))} min` });
		contentEl.createEl("p", { text: DISCLOSURE, cls: "mod-warning" });
		buttonRow(contentEl, [
			{
				text: info.resume ? "Resume" : "Translate",
				cta: true,
				onClick: () => {
					const languages = fields.value();
					if (languages === null) return;
					this.answered = true;
					this.resolve(languages);
					this.close();
				},
			},
			{ text: "Cancel", onClick: () => this.close() },
		]);
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(null);
	}

}

class SplitModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly info: SplitPreflight,
		private readonly resolve: (languages: PairLanguages | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { info, contentEl } = this;
		this.modalEl.addClass("menard-preflight");
		this.setTitle("Split into source and translation notes");
		for (const line of splitLines(info.plan)) contentEl.createEl("p", { text: line });
		const name = contentEl.createEl("p");
		const showName = (target: string | null): void => {
			name.setText(target === null ? "" : `New note: “${info.translationPath(target).replace(/^.*\//, "").replace(/\.md$/, "")}”`);
		};
		const fields = new LanguageFields(contentEl, info.languages, false, { source: info.guessedSource, target: info.guessedTarget }, (languages) =>
			showName(languages.target),
		);
		showName(info.languages.target);
		buttonRow(contentEl, [
			{
				text: "Split",
				cta: true,
				onClick: () => {
					const languages = fields.value();
					if (languages === null) return;
					this.answered = true;
					this.resolve(languages);
					this.close();
				},
			},
			{ text: "Cancel", onClick: () => this.close() },
		]);
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(null);
	}
}

/**
 * The source and target language fields of a preflight, with a warning when
 * the text does not look like the chosen language (offering to swap or use
 * the guessed one) and a refusal when both name the same language (#25).
 */
class LanguageFields {
	private readonly source: HTMLInputElement;
	private readonly target: HTMLInputElement;
	private readonly warning: HTMLElement;

	constructor(
		private readonly parent: HTMLElement,
		languages: PairLanguages,
		disabled: boolean,
		private readonly guesses: { source?: string | undefined; target?: string | undefined },
		private readonly onChange?: (languages: { source: string | null; target: string | null }) => void,
	) {
		this.source = this.field("Source language", languages.source, disabled);
		this.target = this.field("Target language", languages.target, disabled);
		this.warning = parent.createDiv({ cls: "menard-language-warning" });
		this.render();
	}

	/** The confirmed languages, or null after marking what is wrong. */
	value(): PairLanguages | null {
		const source = languageCode(this.source);
		const target = languageCode(this.target);
		if (source === null || target === null) return null;
		if (sameLanguage(source, target)) {
			this.source.setAttribute("aria-invalid", "true");
			this.target.setAttribute("aria-invalid", "true");
			return null;
		}
		return { source, target };
	}

	private field(label: string, value: string, disabled: boolean): HTMLInputElement {
		const row = this.parent.createDiv({ cls: "setting-item" });
		row.createDiv({ cls: "setting-item-name", text: label });
		const input = row.createEl("input", { type: "text", value });
		input.disabled = disabled;
		input.addEventListener("input", () => this.render());
		return input;
	}

	private render(): void {
		const source = canonicalLanguage(this.source.value);
		const target = canonicalLanguage(this.target.value);
		this.onChange?.({ source, target });
		this.warning.empty();
		const say = (text: string, action?: { text: string; run: () => void }): void => {
			this.warning.createEl("p", { text, cls: "mod-warning" });
			if (action !== undefined && !this.source.disabled) {
				buttonRow(this.warning, [
					{
						text: action.text,
						onClick: () => {
							action.run();
							this.render();
						},
					},
				]);
			}
		};
		if (source !== null && target !== null && sameLanguage(source, target)) {
			say(`The source and target languages are both ${languageName(source)}. Choose a different target language.`);
			return;
		}
		const guessed = this.guesses.source;
		const guessedTarget = this.guesses.target;
		const swap = { text: "Swap languages", run: () => ([this.source.value, this.target.value] = [this.target.value, this.source.value]) };
		if (guessed !== undefined && source !== null && !sameLanguage(guessed, source)) {
			const fits = target !== null && sameLanguage(guessed, target) && (guessedTarget === undefined || sameLanguage(guessedTarget, source));
			say(
				`The text looks like ${languageName(guessed)}, not ${languageName(source)}.`,
				fits ? swap : { text: `Use ${languageName(guessed)} as the source`, run: () => (this.source.value = guessed) },
			);
		} else if (guessedTarget !== undefined && target !== null && !sameLanguage(guessedTarget, target)) {
			say(`The translation looks like ${languageName(guessedTarget)}, not ${languageName(target)}.`, {
				text: `Use ${languageName(guessedTarget)} as the target`,
				run: () => (this.target.value = guessedTarget),
			});
		}
	}
}

class BatchModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly info: BatchPreflight,
		private readonly resolve: (languages: PairLanguages | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { info, contentEl } = this;
		this.modalEl.addClass("menard-preflight");
		this.setTitle("Translate or align folder");
		const work = info.items.filter((item) => item.action !== "done");
		const calls = work.reduce((sum, item) => sum + item.calls, 0);
		contentEl.createEl("p", {
			text: `${work.length} ${plural(work.length, "note")} in “${info.folderName}”, one after another in name order: about ${calls} Claude ${plural(calls, "call")} with ${info.model}.`,
		});
		const fields = new LanguageFields(contentEl, info.languages, false, {});
		contentEl.createEl("p", { text: "Pairs that already exist keep their own languages. Cancel stops after the current paragraphs; run the command again to resume." });
		const list = contentEl.createEl("ul");
		for (const line of batchLines(info.items)) list.createEl("li", { text: line });
		contentEl.createEl("p", { text: DISCLOSURE.replace("this note", "these notes"), cls: "mod-warning" });
		buttonRow(contentEl, [
			{
				text: "Start",
				cta: true,
				onClick: () => {
					const languages = fields.value();
					if (languages === null) return;
					this.answered = true;
					this.resolve(languages);
					this.close();
				},
			},
			{ text: "Cancel", onClick: () => this.close() },
		]);
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(null);
	}
}

class MessageModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly message: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(this.heading);
		for (const line of this.message.split("\n")) this.contentEl.createEl("p", { text: line });
		buttonRow(this.contentEl, [{ text: "Close", cta: true, onClick: () => this.close() }]);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class ReportModal extends Modal {
	constructor(
		app: App,
		private readonly report: PairReport,
		private readonly actions: ReportActions,
	) {
		super(app);
	}

	override onOpen(): void {
		const { report, actions, contentEl } = this;
		this.setTitle("Check alignment");
		const rows: [string, readonly (string | number)[]][] = [
			["Only in the source", report.unpairedSource],
			["Source paragraphs never translated (line numbers)", report.untranslated.map((line) => line + 1)],
			["Only in the translation", report.unpairedTarget],
			["Waiting for translation or alignment", report.pending],
			["Edited since aligned, refreshable", report.repaired],
			["Needing realignment", report.degraded],
			["Unreadable Menard lines (line numbers)", report.problems.map((line) => line + 1)],
		];
		const shown = rows.filter(([, items]) => items.length > 0);
		if (shown.length === 0 && actions.repairLink === undefined) contentEl.createEl("p", { text: "The pair is fully aligned." });
		if (actions.repairLink !== undefined) contentEl.createEl("p", { text: "One note links to the other, but the link is not returned." });
		const list = contentEl.createEl("ul");
		for (const [label, items] of shown) list.createEl("li", { text: `${label}: ${items.join(", ")}` });

		const buttons: { text: string; cta?: boolean; onClick: () => void }[] = [];
		const add = (text: string, run: (() => void) | undefined): void => {
			if (run === undefined) return;
			buttons.push({
				text,
				cta: buttons.length === 0,
				onClick: () => {
					this.close();
					run();
				},
			});
		};
		add("Refresh maps", report.repaired.length > 0 ? actions.refresh : undefined);
		add("Realign", report.degraded.length > 0 ? actions.realign : undefined);
		add("Repair pair link", actions.repairLink);
		add("Resume translation", report.pending.length > 0 || report.untranslated.length > 0 ? actions.resume : undefined);
		buttons.push({ text: "Close", cta: buttons.length === 0, onClick: () => this.close() });
		buttonRow(contentEl, buttons);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class NotePicker extends FuzzySuggestModal<TFile> {
	private chosen = false;

	constructor(
		app: App,
		private readonly exclude: TFile,
		private readonly resolve: (file: TFile | null) => void,
	) {
		super(app);
		this.setPlaceholder("Choose the translation note");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((file) => file !== this.exclude);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.chosen = true;
		this.resolve(file);
	}

	override onClose(): void {
		// Obsidian closes the modal before it reports the choice.
		window.setTimeout(() => {
			if (!this.chosen) this.resolve(null);
		}, 0);
	}
}
