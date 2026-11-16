/**
 * Synthetic Spanish and English academic prose for the vault tests, written
 * for this project: abbreviations, citations, footnotes, « » and “ ”
 * quotations, italics and links.
 */

export const SOURCE_PATH = "Collections/Texts/@ruizalmotasim.md";
export const TARGET_PATH = "Collections/Texts/@ruizalmotasim (EN).md";

export const SOURCE_PARAGRAPH_1 =
	"Según el Sr. Ruiz (cf. Ruiz 2002, p. 14), el narrador de *El acercamiento a Almotásim* finge «reseñar» un libro que no existe.[^1]";

export const SOURCE_PARAGRAPH_2 =
	"La pregunta, como señala [[Genette, Gérard|Genette]], es “quién habla” cuando el comentario usurpa el lugar del texto; véase también el art. 3 de la ed. de 1936.";

export const SOURCE_FOOTNOTE = "[^1]: Véase Borges, *Ficciones* (Buenos Aires: Sur, 1944), pp. 35–43.";

export const SOURCE_TEXT = [
	"---",
	"citekey: ruizalmotasim",
	'translation: "[[@ruizalmotasim (EN)]]"',
	"---",
	"",
	"# Texto",
	"",
	SOURCE_PARAGRAPH_1,
	"",
	SOURCE_PARAGRAPH_2,
	"",
	SOURCE_FOOTNOTE,
	"",
].join("\n");

export const TRANSLATE_MARKER_1 = "%%menard:1 p1 translate%%";
export const TRANSLATE_MARKER_2 = "%%menard:1 p2 translate%%";
export const MAP_LINE_1 = "%%menard:1 p1 24.k3x9>22.a0b1%%";

export const TARGET_PARAGRAPH_1 =
	"According to Mr. Ruiz (cf. Ruiz 2002, p. 14), the narrator of *The Approach to Al-Mu'tasim* pretends to “review” a book that does not exist.[^1] ^p1";

export const TARGET_TEXT = [
	"---",
	'source: "[[@ruizalmotasim]]"',
	"sourceLanguage: es",
	"targetLanguage: en",
	"---",
	"",
	"# Text",
	"",
	TRANSLATE_MARKER_1,
	"",
	TRANSLATE_MARKER_2,
	"",
].join("\n");
