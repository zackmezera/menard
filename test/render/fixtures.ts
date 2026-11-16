/**
 * Reading-view markup samples for the render tests, written to mirror what
 * Obsidian 1.13 reading view produces for each Markdown body. Prose is
 * synthetic academic Spanish, plus Don Quijote I.1 (1605) and John Ormsby's
 * 1885 translation (public domain), as in DESIGN.md §4.3.
 */

export const QUIJOTE_SOURCE_S1 =
	"En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.";
export const QUIJOTE_SOURCE_S2 =
	"Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de añadidura los domingos, consumían las tres partes de su hacienda.";
export const QUIJOTE_TARGET_S1 =
	"In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.";
export const QUIJOTE_TARGET_S2 =
	"An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra on Sundays, made away with three-quarters of his income.";

/** The source note; the paragraph is line 4. */
export const QUIJOTE_SOURCE_NOTE = [
	"---",
	'translation: "[[Quijote (EN)]]"',
	"---",
	"## Capítulo primero",
	"En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.[^1] Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de %%p. 2%% añadidura los domingos, consumían las tres partes de su hacienda. ^p1",
	"",
	"[^1]: Galgo: perro de caza.",
	"",
].join("\n");

/** The translation note; the paragraph is line 6, its map line 8. */
export const QUIJOTE_TARGET_NOTE = [
	"---",
	'source: "[[Quijote]]"',
	"sourceLanguage: es",
	"targetLanguage: en",
	"---",
	"## Chapter One",
	"In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.[^1] An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra %%p. 2%% on Sundays, made away with three-quarters of his income. ^p1",
	"",
	"%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%",
	"",
	"[^1]: A greyhound: a hunting dog.",
	"",
].join("\n");

export const QUIJOTE_MAP = "%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%";

function footnoteRef(label: string): string {
	return `<sup data-footnote-id="fnref-${label}-3f9a" class="footnote-ref"><a href="#fn-${label}-3f9a" class="footnote-link" target="_self" rel="noopener nofollow">[${label}]</a></sup>`;
}

/** Reading view of the source paragraph: the inline comment is gone, its spaces stay. */
export const QUIJOTE_SOURCE_HTML = `<p>${QUIJOTE_SOURCE_S1}${footnoteRef("1")} Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de  añadidura los domingos, consumían las tres partes de su hacienda.</p>`;

export const QUIJOTE_TARGET_HTML = `<p>${QUIJOTE_TARGET_S1}${footnoteRef("1")} An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra  on Sundays, made away with three-quarters of his income.</p>`;

/** The target after the reader added one word ("fat") to sentence 2. */
export const QUIJOTE_TARGET_EDITED_HTML = QUIJOTE_TARGET_HTML.replace("and a pigeon", "and a fat pigeon");

export interface ParityCase {
	name: string;
	/** The block body as the text module hands it to projectMarkdown. */
	markdown: string;
	/** The unit element reading view renders for it. */
	html: string;
}

export const PARITY_CASES: readonly ParityCase[] = [
	{
		name: "Quijote source paragraph with footnote ref and inline comment",
		markdown: QUIJOTE_SOURCE_NOTE.split("\n")[4]?.replace(/ \^p1$/, "") ?? "",
		html: QUIJOTE_SOURCE_HTML,
	},
	{
		name: "Ormsby target paragraph",
		markdown: QUIJOTE_TARGET_NOTE.split("\n")[6]?.replace(/ \^p1$/, "") ?? "",
		html: QUIJOTE_TARGET_HTML,
	},
	{
		name: "abbreviations, citation, italics, wikilink alias, external link, guillemets",
		markdown:
			"Según el Sr. Pérez (cf. pp. 23-25), *J. L. Borges* leyó a Poe en Ginebra.[^2] Esa lectura, dice [[Lacan, Jacques|Lacan]], fue «decisiva» para [la revista *Sur*](https://example.org/sur).",
		html:
			`<p>Según el Sr. Pérez (cf. pp. 23-25), <em>J. L. Borges</em> leyó a Poe en Ginebra.${footnoteRef("2")} Esa lectura, dice ` +
			`<a data-href="Lacan, Jacques" href="Lacan, Jacques" class="internal-link" data-tooltip-position="top" aria-label="Lacan, Jacques" target="_blank" rel="noopener nofollow">Lacan</a>, ` +
			`fue «decisiva» para <a href="https://example.org/sur" class="external-link" target="_blank" rel="noopener nofollow">la revista <em>Sur</em></a>.</p>`,
	},
	{
		name: "hard-wrapped paragraph with bold, highlight, inline code, comment and math",
		markdown: "El **concepto** de ==metalepsis== (véase `Genette 1972`) aparece\nen el ensayo %%p. 14%% sobre $x^2$ los «precursores» del autor.",
		html:
			"<p>El <strong>concepto</strong> de <mark>metalepsis</mark> (véase <code>Genette 1972</code>) aparece<br>\n" +
			'en el ensayo  sobre <span class="math math-inline is-loaded"><mjx-container class="MathJax" jax="CHTML">x2</mjx-container></span> los «precursores» del autor.</p>',
	},
	{
		name: "verse quote with a blank line and an attribution",
		markdown: "El río que no vuelve es otro río,\nla página que leo ya es ajena;\n\n— Anónimo, «Copla del lector» (s. XVII)",
		html:
			"<blockquote>\n<p>El río que no vuelve es otro río,<br>\nla página que leo ya es ajena;</p>\n<p>— Anónimo, «Copla del lector» (s. XVII)</p>\n</blockquote>",
	},
	{
		name: "callout body under a translated title",
		markdown: "La traducción citada es de Ormsby (1885).\nLas notas son del editor, cf. *infra*, n. 3.",
		html:
			'<div data-callout-metadata="" data-callout-fold="" data-callout="note" class="callout"><div class="callout-title" dir="auto"><div class="callout-icon"></div><div class="callout-title-inner">Procedencia del texto</div></div>' +
			'<div class="callout-content">\n<p>La traducción citada es de Ormsby (1885).<br>\nLas notas son del editor, cf. <em>infra</em>, n. 3.</p>\n</div></div>',
	},
	{
		name: "English prose with curly quotes, an inline embed and a heading link",
		markdown: "As Ormsby notes, “the *Quijote* is a book about reading.” ![[mapa-de-la-mancha.png]] See [[Borges, Jorge Luis#Ficciones]] for the rest.",
		html:
			"<p>As Ormsby notes, “the <em>Quijote</em> is a book about reading.” " +
			'<span alt="mapa-de-la-mancha.png" src="mapa-de-la-mancha.png" class="internal-embed media-embed image-embed is-loaded"><img alt="mapa-de-la-mancha.png" src="app://mapa.png"></span> ' +
			'See <a data-href="Borges, Jorge Luis#Ficciones" href="Borges, Jorge Luis#Ficciones" class="internal-link">Borges, Jorge Luis &gt; Ficciones</a> for the rest.</p>',
	},
	{
		name: "backslash escapes and a dialogue dash",
		markdown: "El símbolo \\*no\\* es énfasis, ni \\[esto\\] un enlace. —¿Y entonces? —preguntó el editor.",
		html: "<p>El símbolo *no* es énfasis, ni [esto] un enlace. —¿Y entonces? —preguntó el editor.</p>",
	},
];
