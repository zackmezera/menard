/**
 * Renders the translation of one cursor stop for the stacked view, by
 * rendering the target unit offscreen, wrapping it like reading view, and
 * cloning the stop's fragments. Owner: render module. DESIGN.md §9.5.
 */
import { MarkdownRenderChild, MarkdownRenderer, type App, type Component } from "obsidian";
import { ATTR, TRAILING_BLOCK_ID_RE } from "../constants";
import { unitBlocks } from "../align/model";
import type { Block, CursorStop, GlossSource, PairModel } from "../types";
import { FOOTNOTE_REF_SELECTOR } from "./dom-projection";
import { wrapUnit } from "./wrap";

const CACHE_SIZE = 32;

/** A footnote ref `[^label]` (not a definition) or the start of an inline footnote `^[`. */
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)|\^\[/g;

interface RenderedUnit {
	/** The detached container holding the rendered, wrapped unit elements (several for a merged unit). */
	container: HTMLElement;
	unitEls: HTMLElement[];
	child: MarkdownRenderChild;
	owner: Component;
}

export class OffscreenGloss implements GlossSource {
	/** Most recently used last. */
	private readonly cache = new Map<string, Promise<RenderedUnit | null>>();
	/** The target note whose links a gloss element opens, per gloss element. */
	private readonly linkSources = new WeakMap<HTMLElement, string>();
	/** The newest render requested for each gloss element; older ones resolve false. */
	private readonly latest = new WeakMap<HTMLElement, number>();
	private requests = 0;

	constructor(private readonly app: App) {}

	/** LRU of 32 rendered target units, cleared for a path when its model version changes. */
	async render(model: PairModel, stop: CursorStop, into: HTMLElement, owner: Component): Promise<boolean> {
		const request = ++this.requests;
		this.latest.set(into, request);
		const rendered = await this.renderedUnit(model, stop.unit, owner);
		// A quicker, later render for the same element has already filled it.
		if (!rendered || this.latest.get(into) !== request) return false;

		const content = stop.link === null ? cloneUnit(rendered.unitEls) : cloneLink(rendered.container, `${stop.unit}.${stop.link}`);
		if (!content) return false;
		// Clones must not answer the reader's link selectors in the source pane.
		if (content.instanceOf(Element)) content.removeAttribute(ATTR.link);
		for (const tagged of Array.from((content as ParentNode).querySelectorAll(`[${ATTR.link}]`))) tagged.removeAttribute(ATTR.link);
		into.empty();
		into.appendChild(content);
		this.listenForLinks(into, model.targetPath, owner);
		return true;
	}

	private renderedUnit(model: PairModel, key: string, owner: Component): Promise<RenderedUnit | null> {
		const cacheKey = `${model.targetPath}\u0000${key}\u0000${model.version}`;
		const hit = this.cache.get(cacheKey);
		if (hit) {
			this.cache.delete(cacheKey);
			this.cache.set(cacheKey, hit);
			return hit;
		}
		this.evictStale(model);
		const pending = this.renderUnit(model, key, owner).catch(() => null);
		this.cache.set(cacheKey, pending);
		// Nothing rendered is not worth keeping: the next request tries again.
		void pending.then((rendered) => {
			if (rendered === null && this.cache.get(cacheKey) === pending) this.cache.delete(cacheKey);
		});
		while (this.cache.size > CACHE_SIZE) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.evict(oldest);
		}
		return pending;
	}

	private async renderUnit(model: PairModel, key: string, owner: Component): Promise<RenderedUnit | null> {
		const unit = model.unit(key);
		const blocks = unit ? unitBlocks(unit, "target") : [];
		const file = this.app.vault.getFileByPath(model.targetPath);
		if (!unit || blocks.length === 0 || !file) return null;

		const text = await this.app.vault.cachedRead(file);
		const noteLines = text.split("\n");
		// A merged unit's blocks render one after another, separated by blank lines.
		const body = blocks
			.map((block) => {
				const lines = noteLines.slice(block.lines.start, block.lines.end).map((line) => line.replace(/\r$/, ""));
				const lastIndex = lines.length - 1;
				if (lastIndex >= 0) lines[lastIndex] = (lines[lastIndex] as string).replace(TRAILING_BLOCK_ID_RE, "");
				return lines.join("\n");
			})
			.join("\n\n");
		if (body === "") return null;
		// A ref renders as a ref only beside its definition; the definitions' own rendering is not cloned.
		const labels = [...new Set(footnoteRefs(body).filter((label): label is string => label !== null))];
		const markdown = labels.length === 0 ? body : `${body}\n\n${labels.map((label) => `[^${label}]: ${label}`).join("\n\n")}`;

		const container = createDiv({ attr: { [ATTR.offscreen]: "" } });
		const child = owner.addChild(new MarkdownRenderChild(container));
		try {
			await MarkdownRenderer.render(this.app, markdown, container, model.targetPath, child);
			const unitEls = Array.from(container.children)
				.slice(0, blocks.length)
				.filter((el): el is HTMLElement => el.instanceOf(HTMLElement));
			if (unitEls.length !== blocks.length) {
				owner.removeChild(child);
				return null;
			}
			unitEls.forEach((unitEl, i) => {
				renumberFootnoteRefs(unitEl, blocks.length === 1 ? body : (blocks[i] as Block).body, text);
				wrapUnit(unitEl, unit, "target", blocks[i]);
			});
			return { container, unitEls, child, owner };
		} catch (error) {
			owner.removeChild(child);
			throw error;
		}
	}

	/** Drops units rendered for an older version of this pair. */
	private evictStale(model: PairModel): void {
		const prefix = `${model.targetPath}\u0000`;
		const current = `\u0000${model.version}`;
		for (const cacheKey of Array.from(this.cache.keys())) {
			if (cacheKey.startsWith(prefix) && !cacheKey.endsWith(current)) this.evict(cacheKey);
		}
	}

	private evict(cacheKey: string): void {
		const entry = this.cache.get(cacheKey);
		this.cache.delete(cacheKey);
		void entry?.then((rendered) => rendered?.owner.removeChild(rendered.child));
	}

	/** One delegated click listener per gloss element; links open relative to the target note. */
	private listenForLinks(into: HTMLElement, targetPath: string, owner: Component): void {
		const known = this.linkSources.has(into);
		this.linkSources.set(into, targetPath);
		if (known) return;
		owner.registerDomEvent(into, "click", (event) => {
			const target = event.target as Node | null;
			if (!target?.instanceOf(HTMLElement)) return;
			const ref = target.closest(FOOTNOTE_REF_SELECTOR);
			if (ref && into.contains(ref)) {
				// Its definition lives in the translation note, not in the reading view around the gloss.
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const anchor = target.closest("a.internal-link");
			if (!anchor || !into.contains(anchor)) return;
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			const source = this.linkSources.get(into);
			if (href === null || source === undefined) return;
			// The reading view around the gloss would otherwise open it relative to the source note.
			event.preventDefault();
			event.stopPropagation();
			void this.app.workspace.openLinkText(href, source);
		});
	}
}

/** Clones of every unit element, in order: one for a plain unit. */
function cloneUnit(unitEls: readonly HTMLElement[]): Node | null {
	const [first] = unitEls;
	if (first === undefined || unitEls.length === 1) return first?.cloneNode(true) ?? null;
	const fragment = createFragment();
	for (const el of unitEls) fragment.appendChild(el.cloneNode(true));
	return fragment;
}

/**
 * Clones the fragments carrying `link`, from the first to the last, with
 * the inline elements around them (emphasis, links) cut to the range; a
 * link crossing a merged unit's paragraph boundary keeps both pieces.
 */
function cloneLink(root: HTMLElement, link: string): DocumentFragment | null {
	const fragments = root.querySelectorAll(`[${ATTR.link}="${link}"]`);
	const first = fragments[0];
	const last = fragments[fragments.length - 1];
	if (!first || !last) return null;
	const range = root.ownerDocument.createRange();
	range.setStartBefore(first);
	range.setEndAfter(last);
	return range.cloneContents();
}

/** Labels of the footnote refs in `markdown`, in order; null for an inline footnote. */
function footnoteRefs(markdown: string): (string | null)[] {
	return Array.from(markdown.matchAll(FOOTNOTE_REF_RE), (match) => match[1] ?? null);
}

/** Each label's footnote number, numbering footnotes in order of first reference, as reading view does. */
function footnoteNumbers(markdown: string): Map<string, number> {
	const numbers = new Map<string, number>();
	let count = 0;
	for (const label of footnoteRefs(markdown)) {
		if (label === null) count++;
		else if (!numbers.has(label)) numbers.set(label, ++count);
	}
	return numbers;
}

/**
 * Rendered alone, a unit numbers its footnotes from 1; gives each ref the
 * number reading view shows for it in the whole note. Refs pair with the
 * Markdown's refs by order; a count mismatch leaves them as rendered.
 */
function renumberFootnoteRefs(unitEl: HTMLElement, body: string, note: string): void {
	const refs = footnoteRefs(body);
	const sups = Array.from(unitEl.querySelectorAll(FOOTNOTE_REF_SELECTOR));
	if (refs.length === 0 || sups.length !== refs.length) return;
	const local = footnoteNumbers(body);
	const global = footnoteNumbers(note);
	sups.forEach((sup, i) => {
		const label = refs[i];
		const from = label == null ? undefined : local.get(label);
		const to = label == null ? undefined : global.get(label);
		if (from === undefined || to === undefined || from === to) return;
		const textEl = sup.querySelector("a") ?? sup;
		const shown = textEl.textContent ?? "";
		const number = new RegExp(`(^|\\D)${from}(?!\\d)`);
		if (number.test(shown)) textEl.textContent = shown.replace(number, `$1${to}`);
	});
}
