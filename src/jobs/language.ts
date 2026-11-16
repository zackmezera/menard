/**
 * Source-language sanity checks for Translate note and Split: the language a
 * note's properties declare, and a cheap stopword guess at the language of
 * its text. Pure, no dependencies. Owner: jobs module. DESIGN.md §7.1.
 */

/** Frontmatter keys on a source note that may name its language, in order of preference. */
export const LANGUAGE_PROPERTIES = ["originalLanguage", "language", "lang"] as const;

/** Language names (English and the languages' own, accents removed) to BCP 47 codes. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	english: "en",
	ingles: "en",
	anglais: "en",
	englisch: "en",
	inglese: "en",
	spanish: "es",
	espanol: "es",
	castellano: "es",
	castilian: "es",
	espagnol: "es",
	spanisch: "es",
	spagnolo: "es",
	french: "fr",
	francais: "fr",
	frances: "fr",
	franzosisch: "fr",
	francese: "fr",
	german: "de",
	deutsch: "de",
	aleman: "de",
	allemand: "de",
	tedesco: "de",
	italian: "it",
	italiano: "it",
	italien: "it",
	italienisch: "it",
	portuguese: "pt",
	portugues: "pt",
	portugais: "pt",
	portugiesisch: "pt",
	portoghese: "pt",
	catalan: "ca",
	catala: "ca",
	latin: "la",
	latina: "la",
	greek: "el",
	"modern greek": "el",
	"ancient greek": "grc",
	russian: "ru",
	dutch: "nl",
	polish: "pl",
	chinese: "zh",
	japanese: "ja",
	korean: "ko",
	arabic: "ar",
	hebrew: "he",
	turkish: "tr",
	swedish: "sv",
	danish: "da",
	norwegian: "no",
	czech: "cs",
	hungarian: "hu",
	romanian: "ro",
};

/**
 * A BCP 47 code for a property value: a language name ("spanish",
 * "Español") or a code ("es", "pt-BR"). A list gives its first entry.
 * Null for anything else.
 */
export function languageFromProperty(value: unknown): string | null {
	const raw = Array.isArray(value) ? (value as unknown[])[0] : value;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const name = trimmed
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ");
	const named = LANGUAGE_NAMES[name];
	if (named !== undefined) return named;
	// A code proper: a two- or three-letter language subtag, optionally with more subtags.
	if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/.test(trimmed)) return null;
	try {
		return Intl.getCanonicalLocales(trimmed.replace(/_/g, "-"))[0] ?? null;
	} catch {
		return null;
	}
}

/** The language a note's frontmatter declares, from the first LANGUAGE_PROPERTIES key that holds one. */
export function declaredLanguage(frontmatter: Readonly<Record<string, unknown>> | undefined): string | null {
	for (const key of LANGUAGE_PROPERTIES) {
		const code = languageFromProperty(frontmatter?.[key]);
		if (code !== null) return code;
	}
	return null;
}

/**
 * Frequent short words of each language the guess knows. Lists overlap (de,
 * que, la); the guess is decided by the words that do not.
 */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
	en: "the and of to in is that it was for with as his he by on this which be are from at not but have had an or were they their its been has would who what there one".split(" "),
	es: "el la los las de que y en un una por con para no es se del al lo como más pero sus su le ya o este esta porque muy sin sobre también me hasta donde ha fue era entre cuando todo ni".split(" "),
	fr: "le la les de des du et est un une que qui dans en pour pas ne sur au aux il elle ce cette son sa ses avec par plus mais ou nous vous sont été être était comme lui leur".split(" "),
	de: "der die das und ist nicht ein eine zu den dem des mit sich auf für von im auch es an als wie aber wird oder sind war bei nach noch nur er sie wir ich dass über".split(" "),
	it: "il lo la gli le di che e è un una per non con del della dei delle nel nella al alla si sono come ma più anche questo questa era suo sua ha ho cui perché molto".split(" "),
	pt: "o a os as de que e do da dos das em um uma para com não no na nos nas por se mais como mas ao seu sua ele ela é foi são também já pelo pela isso muito quando".split(" "),
};
const STOPWORD_SETS = Object.entries(STOPWORDS).map(([lang, words]) => ({ lang, words: new Set(words) }));

/** Fewer words than this and no guess is made. */
const MIN_WORDS = 20;
/** The best language's stopwords must be at least this share of the words… */
const MIN_SHARE = 0.15;
/** …and outscore the runner-up by this factor. */
const MIN_MARGIN = 1.25;
/** Words looked at; enough for a stable guess, cheap on long notes. */
const MAX_WORDS = 2000;

/**
 * A guess at the language of `text` among en, es, fr, de, it and pt, by
 * stopword frequency; null when the text is short or no language stands out.
 */
export function guessLanguage(text: string): string | null {
	const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, MAX_WORDS);
	if (words.length < MIN_WORDS) return null;
	const scores = STOPWORD_SETS.map(({ lang, words: set }) => ({ lang, hits: words.filter((word) => set.has(word)).length })).sort(
		(a, b) => b.hits - a.hits,
	);
	const [best, second] = scores;
	if (best === undefined || best.hits < words.length * MIN_SHARE) return null;
	if (second !== undefined && best.hits < second.hits * MIN_MARGIN) return null;
	return best.lang;
}

/** True when two BCP 47 codes name the same language (primary subtag), e.g. "en" and "en-GB". */
export function sameLanguage(a: string, b: string): boolean {
	const primary = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
	return primary(a) !== "" && primary(a) === primary(b);
}

/** A language's English name ("es" gives "Spanish"), or the code when it has none. */
export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

/**
 * The languages a preflight proposes for a new pair: the declared language
 * as the source when there is one, else the default; the default target,
 * unless that is the declared language, in which case the default source
 * (an English note under es→en defaults is proposed as en→es).
 */
export function proposeLanguages(declared: string | null, defaults: { source: string; target: string }): { source: string; target: string } {
	if (declared === null) return { ...defaults };
	const target = sameLanguage(declared, defaults.target) ? defaults.source : defaults.target;
	return { source: declared, target };
}
