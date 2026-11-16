/**
 * Reading-view projection: the visible text of a rendered section, with a
 * map back to its text nodes. Must agree word for word with
 * text/inline.ts. Owner: render module. DESIGN.md §5.2.
 */

export interface DomProjection {
	/** Visible text, NFC; a "\n" stands for each <br> and block boundary. */
	text: string;
	/** Text nodes in order with their start offset in `text`; virtual "\n"s belong to no node. */
	pieces: readonly { node: Text; start: number }[];
}

/**
 * Subtrees whose text is not part of the projection. Spike S3 confirms the
 * selectors against Obsidian's reading-view markup; adjust only this list.
 */
export const SKIP_SELECTORS: readonly string[] = [
	"sup.footnote-ref",
	"sup[data-footnote-id]",
	"code",
	"pre",
	".math",
	".internal-embed",
	".markdown-embed",
	".callout-title",
	".menard-gloss",
	".menard-ghost",
];

/** A footnote reference, which travels with the link whose last fragment it follows. */
export const FOOTNOTE_REF_SELECTOR = "sup.footnote-ref, sup[data-footnote-id]";

const SKIP = SKIP_SELECTORS.join(", ");

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// NodeFilter constants, spelled out so the walker needs no window globals.
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

/** Elements whose edges are line boundaries in the projection. */
const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
	"FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION",
	"SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

export function isBlockElement(el: Element): boolean {
	return BLOCK_TAGS.has(el.tagName.toUpperCase());
}

/**
 * Walks `root` with a TreeWalker, skipping footnote refs, code, math,
 * embeds, callout titles and Menard's own gloss and ghost elements.
 * Elements are visited only to prune skipped subtrees and to see <br>;
 * a "\n" is inserted wherever consecutive text nodes sit in different blocks.
 */
export function projectElement(root: HTMLElement): DomProjection {
	if (root.matches(SKIP)) return { text: "", pieces: [] };
	const walker = root.ownerDocument.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
		acceptNode: (node) => (node.nodeType === ELEMENT_NODE && (node as Element).matches(SKIP) ? FILTER_REJECT : FILTER_ACCEPT),
	});

	let text = "";
	const pieces: { node: Text; start: number }[] = [];
	let lastBlock: Element | null = null;

	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === ELEMENT_NODE) {
			if ((node as Element).tagName.toUpperCase() === "BR") text += "\n";
			continue;
		}
		if (node.nodeType !== TEXT_NODE) continue;
		const textNode = node as Text;
		if (textNode.data.length === 0) continue;
		const block = blockAncestor(textNode, root);
		if (lastBlock !== null && block !== lastBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
		lastBlock = block;
		pieces.push({ node: textNode, start: text.length });
		text += textNode.data.normalize("NFC");
	}
	return { text, pieces };
}

function blockAncestor(node: Node, root: HTMLElement): Element {
	for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
		if (isBlockElement(el)) return el;
	}
	return root;
}
