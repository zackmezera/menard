/**
 * The "Report a problem" modal: shows the report, copies it, or saves it as
 * a new note at the vault root. Collecting is read-only; saving creates a
 * new file through SafeWriter and never overwrites one.
 */
import { Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import { SafeWriter } from "../vault/writer";
import { collect } from "./collect";
import type { CollectDeps, Collected } from "./collect";
import { buildReport, renderReport, reportFileName, SNIPPET_CHARS } from "./report";

const INTRO =
	"This report describes the active pair and its open panes so a problem can be reproduced: plugin and Obsidian versions, platform, settings (the Claude path cut to its file name), unit and sentence-map counts, how the reading view tagged each unit, and the heights Obsidian holds for each section. Collecting it changes nothing and does not scroll.";

/** Collects a report for the active pair and opens the modal. */
export async function openProblemReport(deps: CollectDeps): Promise<void> {
	try {
		const collected = await collect(deps);
		new ProblemReportModal(deps.app, collected).open();
	} catch (error) {
		new Notice(`Could not collect the report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

class ProblemReportModal extends Modal {
	private snippets = false;
	private text = "";
	private output: HTMLTextAreaElement | null = null;
	private privacy: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly collected: Collected,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("menard-report");
		this.setTitle("Report a problem");
		contentEl.createEl("p", { text: INTRO });
		this.privacy = contentEl.createEl("p", { cls: "setting-item-description" });
		new Setting(contentEl)
			.setName("Include text snippets")
			.setDesc(`Adds the first ${SNIPPET_CHARS} characters of each paragraph and section, which can help locate a problem.`)
			.addToggle((toggle) =>
				toggle.setValue(this.snippets).onChange((value) => {
					this.snippets = value;
					this.refresh();
				}),
			);
		this.output = contentEl.createEl("textarea", { cls: "menard-report-text", attr: { readonly: "", rows: "16", spellcheck: "false" } });
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "Copy", cls: "mod-cta" }).addEventListener("click", () => void this.copy());
		row.createEl("button", { text: "Save to vault" }).addEventListener("click", () => void this.save());
		this.refresh();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private refresh(): void {
		this.text = renderReport(buildReport({ ...this.collected, snippets: this.snippets }));
		if (this.output) this.output.value = this.text;
		this.privacy?.setText(
			this.snippets
				? `Note text is included only as snippets of up to ${SNIPPET_CHARS} characters. Read the report before sharing it.`
				: "No note text is included: only file paths, unit keys, line numbers, counts and heights.",
		);
	}

	private async copy(): Promise<void> {
		if (await copyText(this.text)) new Notice("Report copied.");
		else new Notice("Could not copy the report; select the text and copy it instead.");
	}

	private async save(): Promise<void> {
		const { vault } = this.app;
		const name = reportFileName(new Date(), (candidate) => vault.getAbstractFileByPath(candidate) !== null);
		try {
			await new SafeWriter(this.app).create(name, this.text);
			new Notice(`Report saved as ${name}.`);
		} catch (error) {
			new Notice(`Could not save the report: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** The web clipboard, falling back to Electron's on desktop when the window lacks focus or permission. */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const electron = (window as unknown as { require?: (id: string) => { clipboard?: { writeText(text: string): void } } }).require;
		try {
			const clipboard = electron?.("electron").clipboard;
			if (!clipboard) return false;
			clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
}
