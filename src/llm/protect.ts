/**
 * Swaps verbatim tokens for numbered placeholders before a prompt, and back
 * after. Pure. Owner: llm module. DESIGN.md §10.3.
 */
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from "../constants";
import { MenardError } from "../errors";
import type { Protected } from "../types";

/**
 * One left-to-right scan; at each position the first matching alternative
 * wins. Escapes and wikilinks are matched only so that their contents are
 * never mistaken for other tokens; they are kept as written.
 */
const TOKEN_RE = new RegExp(
	[
		// An escape never takes a newline: a backslash at a line end is a hard break, and the break still becomes ⟦BR⟧.
		/(?<escape>\\[^\n])/.source,
		/(?<code>(?<ticks>`+)[\s\S]*?[^`]\k<ticks>(?!`))/.source,
		/(?<comment>%%[\s\S]*?%%)/.source,
		/(?<embed>!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\))/.source,
		/(?<wikilink>\[\[[^[\]\n]+\]\])/.source,
		/(?<math>\$\$[\s\S]+?\$\$|\$(?=[^\s$])(?:[^$\n\\]|\\.)*?[^\s\\$]\$(?!\d))/.source,
		/(?<html><!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<(?:https?|mailto):[^<>\s]+>)/.source,
		/(?<footnote>\[\^(?<label>[^\]\s]+)\])/.source,
		/(?<url>\]\((?<target>(?:<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?)\))/.source,
		// A reference definition `[ref]: url "title"` is kept whole: its label must match the links that use it.
		/(?<refdef>(?<=^|\n) {0,3}\[[^\]\n]+\]:[ \t]*\S+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*(?=\n|$))/.source,
		// `[label][]` (collapsed): the label is the reference, so it cannot be translated.
		/(?<collapsed>(?<!\])\[[^[\]\n]+\]\[\])/.source,
		// `[label][ref]` (full): the label is translated, the reference kept.
		/(?<reflink>\]\[(?<ref>[^[\]\n^][^[\]\n]*)\])/.source,
		/(?<bare>(?<![\w@/.])(?:(?:https?|ftp):\/\/[^\s<>[\]"]+|mailto:[^\s<>[\]"]+|www\.[^\s<>[\]"]+))/.source,
	].join("|"),
	"g",
);

const RESERVED_RE = /[⟦⟧]/;
const PLACEHOLDER_RE = /⟦[^⟦⟧\n]*⟧/g;
const WIKILINK_RE = /!?\[\[[^[\]\n]+\]\]/g;

const LINE_BREAK = `${PLACEHOLDER_OPEN}BR${PLACEHOLDER_CLOSE}`;
const BLANK_LINE = `${PLACEHOLDER_OPEN}P${PLACEHOLDER_CLOSE}`;

export interface ProtectOptions {
	/**
	 * "placeholder" (default; quotes and callouts): each "\n\n" becomes ⟦P⟧
	 * and each remaining "\n" ⟦BR⟧. "keep" (paragraphs): soft line breaks
	 * stay as "\n" and get no placeholder.
	 */
	lineBreaks?: "placeholder" | "keep";
}

/**
 * Replaces footnote refs (⟦^label⟧), inline comments, inline code, math,
 * embeds, HTML tags, Markdown link URLs, reference labels of `[text][ref]`,
 * bare URLs (⟦C1⟧, ⟦V1⟧, ⟦U1⟧…), and whole reference definitions and
 * collapsed `[ref][]` links (⟦V…⟧); quote and
 * callout line breaks become ⟦BR⟧ and blank quote lines ⟦P⟧. Wikilinks are
 * left in place and checked verbatim by the validator. Throws
 * MenardError("reserved-character") if the input already contains ⟦ or ⟧.
 */
export function protect(markdown: string, options: ProtectOptions = {}): Protected {
	if (RESERVED_RE.test(markdown)) {
		throw new MenardError("reserved-character", `The text contains ${PLACEHOLDER_OPEN} or ${PLACEHOLDER_CLOSE}, which Menard reserves for placeholders.`);
	}
	const tokens: { placeholder: string; original: string }[] = [];
	const issued = new Set<string>();
	const counters = { C: 0, V: 0, U: 0 };
	const issue = (placeholder: string, original: string): string => {
		if (!issued.has(placeholder)) {
			issued.add(placeholder);
			tokens.push({ placeholder, original });
		}
		return placeholder;
	};
	const numbered = (kind: keyof typeof counters, original: string): string =>
		issue(`${PLACEHOLDER_OPEN}${kind}${++counters[kind]}${PLACEHOLDER_CLOSE}`, original);

	let text = markdown.replace(TOKEN_RE, (match: string, ...rest: unknown[]) => {
		const groups = rest[rest.length - 1] as Record<string, string | undefined>;
		if (groups.comment !== undefined) return numbered("C", match);
		if (groups.code !== undefined || groups.embed !== undefined || groups.math !== undefined || groups.html !== undefined) {
			return numbered("V", match);
		}
		if (groups.footnote !== undefined) return issue(`${PLACEHOLDER_OPEN}^${groups.label}${PLACEHOLDER_CLOSE}`, match);
		if (groups.url !== undefined) return `](${numbered("U", groups.target ?? "")})`;
		if (groups.refdef !== undefined || groups.collapsed !== undefined) return numbered("V", match);
		if (groups.reflink !== undefined) return `][${numbered("U", groups.ref ?? "")}]`;
		if (groups.bare !== undefined) {
			const url = trimBareUrl(match);
			return numbered("U", url) + match.slice(url.length);
		}
		return match;
	});

	if ((options.lineBreaks ?? "placeholder") === "placeholder") {
		text = text.replace(/\n\n?/g, (br) => (br.length === 2 ? issue(BLANK_LINE, br) : issue(LINE_BREAK, br)));
	}
	return { text, tokens };
}

/**
 * A bare URL without the punctuation that ends the sentence around it:
 * trailing `.,;:!?'*_»”’` and any `)` that does not close a `(` inside the URL.
 */
function trimBareUrl(candidate: string): string {
	let url = candidate;
	for (;;) {
		const last = url.charAt(url.length - 1);
		if (/[.,;:!?'*_»”’]/.test(last)) {
			url = url.slice(0, -1);
		} else if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
			url = url.slice(0, -1);
		} else {
			return url;
		}
	}
}

/** Restores every placeholder; the inverse of protect for unchanged text. Unknown placeholders are left as they are. */
export function restore(text: string, tokens: Protected["tokens"]): string {
	const originals = new Map(tokens.map((token) => [token.placeholder, token.original]));
	return text.replace(PLACEHOLDER_RE, (placeholder) => originals.get(placeholder) ?? placeholder);
}

/** Every placeholder occurrence in `text`, in order, including ones protect never issues. */
export function placeholdersIn(text: string): string[] {
	return text.match(PLACEHOLDER_RE) ?? [];
}

/** Every wikilink `[[…]]` occurrence in `text`, in order; embeds `![[…]]` are not wikilinks. */
export function wikilinksIn(text: string): string[] {
	return (text.match(WIKILINK_RE) ?? []).filter((link) => !link.startsWith("!"));
}
