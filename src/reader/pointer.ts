/**
 * Click-to-jump and hover on sentence spans, delegated per pane, and the
 * DOM queries that map the render module's attributes to cursor stops.
 * Owner: reader module. DESIGN.md §9.2, §9.8.
 */
import type { Component } from "obsidian";
import { ATTR, CLS } from "../constants";
import type { CursorStop, UnitKey } from "../types";
import { parseLinkAttr, sameStop, stopAttr } from "./cursor";

export interface PointerHandlers {
	jump(stop: CursorStop): void;
	hover(stop: CursorStop | null): void;
	hoverEnabled(): boolean;
}

/** Pointer dwell before hover shows a partner. */
const HOVER_DWELL_MS = 120;
/** Clicks on these keep their own meaning and never move the cursor. */
const NO_JUMP = "a, .internal-link, .footnote-ref, button, input";
/**
 * Elements the reader inserts into a pane. They hold clones of target-side
 * markup (a whole-unit gloss keeps its unit attribute), so they are never
 * stops and never answer the queries below.
 */
const INSERTED = `.${CLS.gloss}, .${CLS.ghost}`;

/** Stop under an event target: the closest span's data-menard-link, or the unit's data-menard-unit. Pure DOM read. */
export function stopFromTarget(target: EventTarget | null): CursorStop | null {
	const el = targetElement(target);
	if (!el || el.closest(INSERTED)) return null;
	const link = el.closest(`[${ATTR.link}]`)?.getAttribute(ATTR.link);
	if (link) return parseLinkAttr(link);
	const unit = el.closest(`[${ATTR.unit}]`)?.getAttribute(ATTR.unit);
	return unit ? { unit, link: null } : null;
}

/**
 * Registers click (single click, collapsed selection, not on a link,
 * button or footnote ref) and hover (mouse only, 120 ms dwell) handlers.
 */
export function attachPointer(owner: Component, container: HTMLElement, handlers: PointerHandlers): void {
	owner.registerDomEvent(container, "click", (event) => {
		if (event.button !== 0 || event.detail > 1) return;
		if (targetElement(event.target)?.closest(NO_JUMP)) return;
		const selection = container.ownerDocument.getSelection();
		if (selection && !selection.isCollapsed) return;
		const stop = stopFromTarget(event.target);
		if (stop) handlers.jump(stop);
	});

	let shown: CursorStop | null = null;
	let pending: CursorStop | null = null;
	let timer: number | null = null;
	const cancel = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		pending = null;
	};
	const show = (stop: CursorStop | null): void => {
		cancel();
		if (sameStop(stop, shown)) return;
		shown = stop;
		handlers.hover(stop);
	};

	owner.registerDomEvent(container, "pointerover", (event) => {
		if (event.pointerType !== "mouse" || !handlers.hoverEnabled()) return;
		// The ghost card sits under the hovered line; reaching it keeps that hover.
		if (targetElement(event.target)?.closest(`.${CLS.ghost}`)) return;
		const stop = stopFromTarget(event.target);
		if (stop === null) return show(null);
		if (stop.link === null && unitHasLinks(event.target)) return;
		if (sameStop(stop, shown)) return cancel();
		if (sameStop(stop, pending)) return;
		cancel();
		pending = stop;
		timer = window.setTimeout(() => show(stop), HOVER_DWELL_MS);
	});
	owner.registerDomEvent(container, "pointerleave", () => show(null));
	owner.register(cancel);
}

// ─── Queries over the render module's DOM contract ──────────────────────────

/** Every element in `root`, `root` included, matching `selector`, in document order; never one inside a gloss or ghost card. */
export function queryAll(root: HTMLElement, selector: string): HTMLElement[] {
	const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
	return (root.matches(selector) ? [root, ...found] : found).filter((el) => !el.closest(INSERTED));
}

/** The sentence fragments of a link stop in `root`; empty for a whole-unit stop. */
export function linkFragments(root: HTMLElement, stop: CursorStop): HTMLElement[] {
	return stop.link === null ? [] : queryAll(root, attrSelector(ATTR.link, stopAttr(stop)));
}

export function unitElements(root: HTMLElement, key: UnitKey): HTMLElement[] {
	return queryAll(root, attrSelector(ATTR.unit, key));
}

export function unitElement(root: HTMLElement, key: UnitKey): HTMLElement | null {
	return unitElements(root, key)[0] ?? null;
}

/** What the reader looks at for a stop: its fragments, or its unit element when none is rendered. */
export function stopElements(root: HTMLElement, stop: CursorStop): HTMLElement[] {
	const fragments = linkFragments(root, stop);
	return fragments.length > 0 ? fragments : unitElements(root, stop.unit);
}

export function attrSelector(name: string, value: string): string {
	return `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

/** True when the target sits in a unit whose sentences are wrapped: the gap between two spans. */
function unitHasLinks(target: EventTarget | null): boolean {
	return targetElement(target)?.closest(`[${ATTR.unit}]`)?.querySelector(`[${ATTR.link}]`) != null;
}

function targetElement(target: EventTarget | null): Element | null {
	if (!target || !("instanceOf" in target)) return null;
	const node = target as Node;
	if (node.instanceOf(Element)) return node;
	return node.instanceOf(Text) ? node.parentElement : null;
}
