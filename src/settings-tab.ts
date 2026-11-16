/**
 * The declarative settings tab (Obsidian 1.13+). Owner: integration.
 * DESIGN.md §12.1.
 */
import { Notice, PluginSettingTab } from "obsidian";
import type { App, Plugin, SettingDefinitionItem } from "obsidian";
import { canonicalLanguage } from "./jobs/modals";
import { detectClaude } from "./llm/detect";
import type { MenardSettings } from "./types";

/** What the tab needs from the plugin. */
export interface SettingsHost extends Plugin {
	settings: MenardSettings;
	saveSettings(): Promise<void>;
	checkClaude(): Promise<void>;
}

type Key = keyof MenardSettings;

export class MenardSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	/** Groups, in order: Translation backend, Languages, Notes, Reading, Editing, Safety. */
	override getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		return [
			{
				type: "group",
				heading: "Translation backend",
				items: [
					{
						name: "Privacy",
						desc:
							"Translating and aligning run the Claude Code command-line tool on this computer. The text of the note is sent to Anthropic by that tool, under your own Claude account; a paid plan is needed. Reading needs neither. Menard sends no telemetry.",
					},
					{
						name: "Claude Code path",
						desc: "Absolute path to the claude executable. Leave empty to look in the usual install locations.",
						control: { type: "text", key: "claudePath", placeholder: "/Users/you/.local/bin/claude", validate: absolutePath },
					},
					{
						name: "Detect",
						desc: "Search the usual locations and your login shell, and fill in the path.",
						action: () => void this.detect(),
					},
					{
						name: "Test connection",
						desc: "Send a one-line request and report the path, model and response time.",
						action: () => void this.host.checkClaude(),
					},
					{
						name: "Model",
						desc: "Model alias or full model id passed to Claude Code, for example sonnet or opus.",
						control: { type: "text", key: "model", placeholder: "sonnet", validate: (value) => (value.trim() === "" ? "Enter a model." : undefined) },
					},
					{
						name: "Parallel requests",
						desc: "How many paragraphs are translated at the same time.",
						control: { type: "slider", key: "concurrency", min: 1, max: 4, step: 1 },
					},
					{
						name: "Timeout",
						desc: "Seconds to wait for one request before stopping it.",
						control: { type: "number", key: "timeoutSeconds", min: 30, max: 1800, step: 1, validate: range(30, 1800) },
					},
					{
						name: "Retries after invalid output",
						desc: "How often a paragraph is sent again when the answer fails validation.",
						control: { type: "slider", key: "maxRetries", min: 0, max: 3, step: 1 },
					},
				],
			},
			{
				type: "group",
				heading: "Languages",
				items: [
					{
						name: "Source language",
						desc: "Default language of the notes you translate, as a code such as es or pt-BR. Each pair keeps its own.",
						control: { type: "text", key: "defaultSourceLanguage", placeholder: "es", validate: languageTag },
					},
					{
						name: "Target language",
						desc: "Default language to translate into. It also names the new note, for example (EN).",
						control: { type: "text", key: "defaultTargetLanguage", placeholder: "en", validate: languageTag },
					},
					{
						name: "Extra abbreviations",
						desc: "Abbreviations that do not end a sentence, one language per line, for example: es: art núm.",
						control: { type: "textarea", key: "extraAbbreviations", rows: 3 },
					},
					{
						name: "Split dialogue",
						desc: "Treat each dialogue dash as the start of a new sentence.",
						control: { type: "toggle", key: "splitDialogue" },
					},
					{
						name: "Extra instructions",
						desc: "Added to every translation request, for example a glossary or a register to keep.",
						control: { type: "textarea", key: "extraInstructions", rows: 4 },
					},
				],
			},
			{
				type: "group",
				heading: "Notes",
				items: [
					{
						name: "Text start heading",
						desc: "The text to align starts after the heading with this name. Leave empty to start after a heading named Text, or, without one, after the leading link, button and embed lines.",
						control: { type: "text", key: "textStartHeading", placeholder: "Text" },
					},
					{
						name: "Skipped sections",
						desc: "Headings whose sections are never translated or aligned, separated by commas or new lines.",
						control: { type: "textarea", key: "skipHeadings", rows: 3 },
					},
					{
						name: "Translation heading",
						desc: "In a note that holds both texts, the heading where the translation starts. Used when splitting.",
						control: { type: "text", key: "translationHeading", placeholder: "English translation" },
					},
					{
						name: "New note properties",
						desc: "Properties added to every new translation note, one key: value per line.",
						control: { type: "textarea", key: "newNoteProperties", placeholder: "collection: translation", rows: 3 },
					},
				],
			},
			{
				type: "group",
				heading: "Reading",
				items: [
					{
						name: "Reading keys",
						desc: "Step through sentences with j, k and the arrow keys in reading view.",
						control: { type: "toggle", key: "readingKeys" },
					},
					{
						name: "Show partner on hover",
						desc: "Highlight the matching sentence when the pointer rests on one.",
						control: { type: "toggle", key: "hoverPartner" },
					},
					{
						name: "Hide translation until revealed",
						desc: "In stacked view, keep the translation hidden until you press space.",
						control: { type: "toggle", key: "revealMode" },
					},
					{
						name: "Fade other sentences",
						desc: "While a sentence is current, fade everything but it and its partner.",
						control: { type: "toggle", key: "dimInactive" },
					},
					{
						name: "Faded opacity",
						desc: "How visible the faded text stays, in percent.",
						control: { type: "slider", key: "dimOpacity", min: 20, max: 80, step: 10 },
					},
				],
			},
			{
				type: "group",
				heading: "Editing",
				items: [
					{
						name: "Hide paragraph ids",
						desc: "Hide the ids Menard adds to paragraphs in live preview, except on the line you edit.",
						control: { type: "toggle", key: "hideBlockIds" },
					},
					{
						name: "Hide sentence maps",
						desc: "Hide sentence-map lines in live preview, except when the cursor is on them.",
						control: { type: "toggle", key: "hideSentenceMaps" },
					},
				],
			},
			{
				type: "group",
				heading: "Safety",
				items: [
					{
						name: "Backups to keep",
						desc: "Copies of notes saved in the plugin folder before Menard replaces your text.",
						control: { type: "number", key: "backupCount", min: 1, max: 500, step: 1, validate: range(1, 500) },
					},
				],
			},
		];
	}

	/** Writes `plugin.settings` like the default, then saves through the plugin so editor extensions refresh. */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		(this.host.settings as unknown as Record<string, unknown>)[key] = value;
		await this.host.saveSettings();
	}

	private async detect(): Promise<void> {
		try {
			const found = await detectClaude(this.host.settings.claudePath, { probeShell: true });
			if (found.path === null) {
				new Notice(`Claude Code was not found. Looked in: ${found.tried.join(", ")}.`);
				return;
			}
			await this.setControlValue("claudePath", found.path);
			this.update();
			new Notice(`Found Claude Code at ${found.path}.`);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Could not search for Claude Code.");
		}
	}
}

function absolutePath(value: string): string | undefined {
	const path = value.trim();
	if (path === "" || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return undefined;
	return "Enter an absolute path, or leave empty to detect it.";
}

function languageTag(value: string): string | undefined {
	return canonicalLanguage(value) === null ? "Enter a language code such as es or en." : undefined;
}

function range(min: number, max: number): (value: number) => string | undefined {
	return (value) => (Number.isFinite(value) && value >= min && value <= max ? undefined : `Enter a number from ${min} to ${max}.`);
}
