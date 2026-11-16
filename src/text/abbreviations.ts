/**
 * Built-in abbreviation lists for the segmenter's merge pass. Pure.
 * Owner: text module. DESIGN.md §5.3.
 */

/** Lower-cased, without the final period, keyed by primary language subtag. */
export const BUILTIN_ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
	es: [
		"sr", "sra", "srta", "dr", "dra", "d", "dña", "ud", "uds", "p", "pp", "n", "nn", "núm", "vol", "vols",
		"cap", "caps", "s", "ss", "ed", "eds", "trad", "cf", "ej", "etc", "fig", "art", "op", "cit", "ib", "ibid",
		"id", "col", "cols", "t", "vid", "apud",
	],
	en: [
		"mr", "mrs", "ms", "dr", "st", "p", "pp", "n", "no", "vol", "vols", "ed", "eds", "trans", "ch", "cf", "etc",
		"fig", "e.g", "i.e", "ibid", "op", "cit", "ca", "vs",
	],
};

/**
 * The abbreviation set for `lang`: built-ins for its primary subtag plus the
 * user's lines for that language from the extraAbbreviations setting
 * ("es: art núm" one language per line).
 */
export function abbreviationsFor(lang: string, extra: string): Set<string> {
	const primary = primarySubtag(lang);
	const set = new Set(BUILTIN_ABBREVIATIONS[primary] ?? []);
	for (const line of extra.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1 || primarySubtag(line.slice(0, colon)) !== primary) continue;
		for (const word of line.slice(colon + 1).split(/[\s,]+/)) {
			const normalized = word.trim().toLowerCase().replace(/\.+$/, "");
			if (normalized !== "") set.add(normalized);
		}
	}
	return set;
}

function primarySubtag(lang: string): string {
	return (lang.trim().toLowerCase().split(/[-_]/)[0] ?? "").trim();
}
