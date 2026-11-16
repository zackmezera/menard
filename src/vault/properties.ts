/**
 * Frontmatter values Menard writes. Pure. Owner: vault module. DESIGN.md §4.1.
 */
import { FM } from "../constants";

const PROPERTY_LINE_RE = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set(Object.values(FM));

/**
 * Parses the newNoteProperties setting (`key: value` per line). Skips blank
 * and malformed lines, lines without a value, and Menard's own pair keys,
 * which the setting must never override. One pair of surrounding quotes is
 * removed from a value; a later line wins over an earlier one with the same key.
 */
export function parseNewNoteProperties(value: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of value.split(/\r?\n/)) {
		const match = PROPERTY_LINE_RE.exec(line.trim());
		if (!match) continue;
		const key = match[1] ?? "";
		const text = unquote((match[2] ?? "").trim());
		if (text === "" || RESERVED_KEYS.has(key)) continue;
		properties[key] = text;
	}
	return properties;
}

/**
 * The frontmatter value of a link to `linktext`: `[[linktext]]`. It is a
 * value for `processFrontMatter`, whose YAML serializer adds the quotes that
 * appear on disk (`translation: "[[@ruizalmotasim (EN)]]"`). Pass the
 * linktext from `metadataCache.fileToLinktext`.
 */
export function wikilinkValue(linktext: string): string {
	return `[[${linktext}]]`;
}

/** Translation note path: `<dir>/<basename> (<TARGET>).md`, normalized. */
export function translationPath(sourcePath: string, targetLanguage: string): string {
	const path = normalizeVaultPath(sourcePath);
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const basename = name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
	const file = `${basename} (${targetLanguage.trim().toUpperCase()}).md`;
	return normalizeVaultPath(dir === "" ? file : `${dir}/${file}`);
}

/** The pure part of Obsidian's normalizePath: forward slashes, no empty or edge segments, NFC. */
function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "")
		.normalize("NFC");
}

function unquote(text: string): string {
	const first = text[0];
	if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1);
	return text;
}
