/**
 * Removes what Align and Translate note add to a note, Menard's own ids
 * (`^p12`) and Menard lines, so an aligned note gives back its pristine
 * text. User ids such as `^intro` stay.
 */
export function stripMenard(text: string): string {
	return text
		// A Menard line goes with the blank line inserted before it; one at the very top, with the one after it.
		.replace(/\n\n%%menard:1 [^%\n]+%%(?=\n|$)/g, "")
		.replace(/^%%menard:1 [^%\n]+%%\n\n?/gm, "")
		.replace(/ \^p\d+$/gm, "")
		.replace(/^\^p\d+\n\n?/gm, "");
}
