/**
 * The stacked view's gloss slot under the current link, with reveal and
 * anchor-preserving reflow, and the hover ghost card. Owner: reader module.
 * DESIGN.md §9.5, §9.8.
 */
import { Component } from "obsidian";
import { ATTR, CLS } from "../constants";
import type { CursorStop, GlossSource, PairModel } from "../types";
import { stopAttr } from "./cursor";
import { linkFragments, stopElements } from "./pointer";

const HIDDEN_LABEL = "Translation hidden";
/** Inline wrappers a gloss climbs out of when the fragment ends them, so it is not italic, bold or a link. */
const INLINE_WRAPPERS = new Set(["A", "B", "CODE", "DEL", "EM", "I", "MARK", "S", "SPAN", "STRONG", "SUB", "SUP", "U"]);

interface Rendered {
	el: HTMLElement;
	id: string;
	owner: Component;
}

export class StackedGloss {
	private slot: Rendered | null = null;
	/** The current link's first fragment: the text the eye is on. */
	private anchor: HTMLElement | null = null;
	private ghost: Rendered | null = null;
	private ticket = 0;
	private ghostTicket = 0;

	constructor(
		private readonly gloss: GlossSource,
		private readonly owner: Component,
	) {}

	/**
	 * Moves the single slot after the stop's last source fragment inside
	 * `container`, keeping the current fragment's on-screen y fixed.
	 * Concealed when `concealed` is true.
	 */
	async show(container: HTMLElement, scroller: HTMLElement, model: PairModel, stop: CursorStop, concealed: boolean): Promise<void> {
		const ticket = ++this.ticket;
		const id = renderId(model, stop);
		let next = this.slot?.id === id ? this.slot : null;
		if (!next) {
			next = await this.render(model, stop, CLS.gloss, () => ticket === this.ticket);
			if (!next) {
				if (ticket === this.ticket) this.remove(scroller);
				return;
			}
			next.el.setAttribute("role", "note");
		}
		const elements = stopElements(container, stop);
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (!first || !last) {
			if (next !== this.slot) this.owner.removeChild(next.owner);
			this.remove(scroller);
			return;
		}
		const previous = this.slot;
		const slot = next;
		preserveAnchor(scroller, first, () => {
			if (previous && previous !== slot) {
				previous.el.remove();
				this.owner.removeChild(previous.owner);
			}
			setConcealed(slot.el, concealed);
			insertAfter(last, slot.el, linkFragments(container, stop).length === 0);
		});
		this.slot = slot;
		this.anchor = first;
	}

	/** Shows the concealed gloss without moving the text the reader is on. */
	reveal(scroller: HTMLElement): void {
		const slot = this.slot;
		if (!slot?.el.classList.contains(CLS.concealed)) return;
		this.withAnchor(scroller, () => setConcealed(slot.el, false));
	}

	remove(scroller: HTMLElement | null): void {
		this.ticket++;
		const slot = this.slot;
		if (!slot) return;
		if (scroller) this.withAnchor(scroller, () => slot.el.remove());
		else slot.el.remove();
		this.owner.removeChild(slot.owner);
		this.slot = null;
		this.anchor = null;
	}

	/** Floating card with the partner of a hovered link; positioned by CSS at its static spot, so text never reflows. */
	async showGhost(container: HTMLElement, model: PairModel, stop: CursorStop): Promise<void> {
		const ticket = ++this.ghostTicket;
		const id = renderId(model, stop);
		if (this.ghost?.id === id && this.ghost.el.isConnected) return;
		const card = await this.render(model, stop, CLS.ghost, () => ticket === this.ghostTicket);
		if (!card) return;
		const elements = stopElements(container, stop);
		const last = elements[elements.length - 1];
		this.dropGhost();
		if (!last) {
			this.owner.removeChild(card.owner);
			return;
		}
		card.el.setAttribute("aria-hidden", "true");
		insertAfter(last, card.el, linkFragments(container, stop).length === 0);
		this.ghost = card;
	}

	hideGhost(): void {
		this.ghostTicket++;
		this.dropGhost();
	}

	private dropGhost(): void {
		if (!this.ghost) return;
		this.ghost.el.remove();
		this.owner.removeChild(this.ghost.owner);
		this.ghost = null;
	}

	private withAnchor(scroller: HTMLElement, mutate: () => void): void {
		if (this.anchor?.isConnected) preserveAnchor(scroller, this.anchor, mutate);
		else mutate();
	}

	private async render(model: PairModel, stop: CursorStop, cls: string, stillWanted: () => boolean): Promise<Rendered | null> {
		const el = createSpan({ cls, attr: { lang: model.languages.target } });
		const owner = this.owner.addChild(new Component());
		const shown = await this.gloss.render(model, stop, el, owner);
		if (shown && stillWanted()) return { el, id: renderId(model, stop), owner };
		this.owner.removeChild(owner);
		return null;
	}
}

/**
 * Anchor-preserving reflow: reads the anchor's top, mutates, reads again and
 * scrolls by the difference, so the text the eye is on does not move.
 */
export function preserveAnchor(scroller: HTMLElement, anchor: HTMLElement, mutate: () => void): void {
	const before = anchor.getBoundingClientRect().top;
	mutate();
	const after = anchor.getBoundingClientRect().top;
	if (after !== before) scroller.scrollTop += after - before;
}

function setConcealed(el: HTMLElement, concealed: boolean): void {
	el.classList.toggle(CLS.concealed, concealed);
	if (concealed) el.setAttribute("aria-label", HIDDEN_LABEL);
	else el.removeAttribute("aria-label");
}

/**
 * Puts `el` right after the last fragment, climbing out of inline wrappers
 * the fragment closes. A whole unit gets it after the unit element.
 */
function insertAfter(last: HTMLElement, el: HTMLElement, wholeUnit: boolean): void {
	let at: Element = last;
	if (!wholeUnit) {
		while (at.parentElement && !at.parentElement.hasAttribute(ATTR.unit) && INLINE_WRAPPERS.has(at.parentElement.tagName) && isLastChild(at)) {
			at = at.parentElement;
		}
	}
	at.after(el);
}

function isLastChild(el: Element): boolean {
	for (let next = el.nextSibling; next; next = next.nextSibling) {
		if (next.nodeType !== 3 || (next.textContent ?? "").trim() !== "") return false;
	}
	return true;
}

function renderId(model: PairModel, stop: CursorStop): string {
	return `${model.sourcePath}@${model.version}#${stopAttr(stop)}`;
}
