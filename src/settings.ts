import type { MenardSettings, ParseOptions } from "./types";

/** Defaults; design-owned. The settings tab lives in settings-tab.ts. */
export const DEFAULT_SETTINGS: Readonly<MenardSettings> = {
	claudePath: "",
	model: "sonnet",
	concurrency: 2,
	timeoutSeconds: 180,
	maxRetries: 2,

	defaultSourceLanguage: "es",
	defaultTargetLanguage: "en",
	extraAbbreviations: "",
	splitDialogue: false,
	extraInstructions: "",

	textStartHeading: "",
	skipHeadings: "Bibliografía, Bibliography, Obras citadas, Works cited, Referencias, References",
	translationHeading: "English translation",
	newNoteProperties: "",

	readingKeys: true,
	hoverPartner: true,
	revealMode: false,
	dimInactive: false,
	dimOpacity: 50,

	hideBlockIds: true,
	hideSentenceMaps: true,

	backupCount: 30,
};

/** Splits the skipHeadings setting into trimmed, non-empty heading texts. */
export function parseHeadingList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** The scanner options a set of settings implies; an empty start heading means "find the start safely" (#26). */
export function parseOptions(settings: MenardSettings): ParseOptions {
	const textStartHeading = settings.textStartHeading.trim();
	return {
		textStartHeading,
		skipHeadings: parseHeadingList(settings.skipHeadings),
		...(textStartHeading === "" ? { autoTextStart: true } : {}),
	};
}
