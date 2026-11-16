/**
 * Paragraph scroll sync between the two panes of a facing session, always
 * on, and the scroll writer that lets it ignore its own echoes.
 * Owner: reader module. DESIGN.md §9.4.
 */
import type { Component } from "obsidian";
import { ATTR } from "../constants";
import type { PairModel, Side } from "../types";
import { scrollerBox } from "./facing";
import { followerScrollTop, fractionThrough, readingLine } from "./geometry";
import { unitElements } from "./pointer";

export interface SyncPane {
	side: Side;
	/** The reading view's scroller element. */
	scroller: HTMLElement;
	/** previewMode.applyScroll(line). */
	applyScroll(line: number): void;
}

/** Input on a pane makes it the driver for this long. */
const DRIVER_MS = 150;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** Writes scrollTop for Menard and recognizes the resulting scroll event as an echo. */
export class ScrollWriter {
	private readonly expected = new WeakMap<HTMLElement, number>();

	write(scroller: HTMLElement, top: number, smooth: boolean): void {
		if (Math.abs(scroller.scrollTop - top) < 1) return;
		this.expected.set(scroller, top);
		if (smooth) scroller.scrollTo({ top, behavior: "smooth" });
		else scroller.scrollTop = top;
	}

	/**
	 * True while Menard's last write to the scroller is in flight: every frame
	 * of a smooth scroll, and the arrival, after which the expectation ends.
	 * User input ends it sooner through `forget`.
	 */
	isEcho(scroller: HTMLElement): boolean {
		const top = this.expected.get(scroller);
		if (top === undefined) return false;
		if (Math.abs(scroller.scrollTop - top) <= 1) this.expected.delete(scroller);
		return true;
	}

	/** The user took over this scroller; stop expecting a programmatic position. */
	forget(scroller: HTMLElement): void {
		this.expected.delete(scroller);
	}
}

type Placement = { kind: "in"; key: string; fraction: number } | { kind: "between"; above: string; below: string; fraction: number };

/**
 * Elects the driver pane from user input (wheel, pointer, touch, keys) and
 * moves the follower so the partner of the unit at the driver's reading
 * line sits level with it, proportionally within the unit. Never moves the
 * reading cursor.
 */
export function attachScrollSync(owner: Component, panes: readonly [SyncPane, SyncPane], model: () => PairModel | null, writer: ScrollWriter): void {
	let driver: SyncPane | null = null;
	let driverUntil = 0;
	let frame: number | null = null;

	const elect = (pane: SyncPane): void => {
		driver = pane;
		driverUntil = Date.now() + DRIVER_MS;
		writer.forget(pane.scroller);
	};
	const onScroll = (pane: SyncPane): void => {
		if (writer.isEcho(pane.scroller)) return;
		if (pane !== driver || Date.now() > driverUntil) return;
		driverUntil = Date.now() + DRIVER_MS;
		if (frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			follow(pane, pane === panes[0] ? panes[1] : panes[0], model, writer, true);
		});
	};

	for (const pane of panes) {
		const passive = { passive: true };
		owner.registerDomEvent(pane.scroller, "wheel", () => elect(pane), passive);
		owner.registerDomEvent(pane.scroller, "touchstart", () => elect(pane), passive);
		owner.registerDomEvent(pane.scroller, "pointerdown", () => elect(pane), passive);
		owner.registerDomEvent(pane.scroller, "keydown", (event) => {
			if (SCROLL_KEYS.has(event.key)) elect(pane);
		});
		owner.registerDomEvent(pane.scroller, "scroll", () => onScroll(pane), passive);
	}
	owner.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
}

function follow(driver: SyncPane, follower: SyncPane, model: () => PairModel | null, writer: ScrollWriter, mayJump: boolean): void {
	const current = model();
	if (!current) return;
	const paired = new Map(current.anchors().map((a) => [a.key, a]));
	const placement = locate(driver.scroller, readingLine(scrollerBox(driver.scroller)), (key) => paired.has(key));
	if (!placement) return;

	const box = scrollerBox(follower.scroller);
	if (placement.kind === "in") {
		const rect = unitRect(follower.scroller, placement.key);
		if (rect) {
			writer.write(follower.scroller, followerScrollTop(box, rect.top, rect.height, placement.fraction), false);
			return;
		}
		const anchor = paired.get(placement.key);
		if (!anchor || !mayJump) return;
		follower.applyScroll(follower.side === "source" ? anchor.source.start : anchor.target.start);
		window.requestAnimationFrame(() => follow(driver, follower, model, writer, false));
		return;
	}
	const above = unitRect(follower.scroller, placement.above);
	const below = unitRect(follower.scroller, placement.below);
	if (!above || !below) return;
	writer.write(follower.scroller, followerScrollTop(box, above.bottom, below.top - above.bottom, placement.fraction), false);
}

/**
 * Where the reading line falls in the driver: inside a paired unit, or in
 * the gap between two paired units. Null inside an unpaired unit, which
 * parks the follower.
 */
function locate(scroller: HTMLElement, line: number, isPaired: (key: string) => boolean): Placement | null {
	const rect = scroller.getBoundingClientRect();
	const hit = scroller.ownerDocument.elementFromPoint(rect.left + rect.width / 2, line);
	const hitUnit = hit && scroller.contains(hit) ? hit.closest<HTMLElement>(`[${ATTR.unit}]`) : null;
	if (hitUnit) return inside(scroller, hitUnit, line, isPaired);

	let above: HTMLElement | null = null;
	let below: HTMLElement | null = null;
	for (const unit of Array.from(scroller.querySelectorAll<HTMLElement>(`[${ATTR.unit}]`))) {
		const box = unit.getBoundingClientRect();
		if (box.top <= line && line <= box.bottom) return inside(scroller, unit, line, isPaired);
		if (!isPaired(keyOf(unit))) continue;
		if (box.bottom < line) above = unit;
		else if (!below && box.top > line) below = unit;
	}
	if (!above || !below) return null;
	const top = above.getBoundingClientRect().bottom;
	return { kind: "between", above: keyOf(above), below: keyOf(below), fraction: fractionThrough(top, below.getBoundingClientRect().top - top, line) };
}

function inside(scroller: HTMLElement, unit: HTMLElement, line: number, isPaired: (key: string) => boolean): Placement | null {
	const key = keyOf(unit);
	if (!isPaired(key)) return null;
	const box = unitRect(scroller, key) ?? unit.getBoundingClientRect();
	return { kind: "in", key, fraction: fractionThrough(box.top, box.height, line) };
}

/**
 * The box around every rendered element of a unit: one for a plain unit,
 * one per paragraph for a merged unit (ADR 0010), so a reading line in its
 * second paragraph is placed proportionally through both.
 */
function unitRect(root: HTMLElement, key: string): { top: number; bottom: number; height: number } | null {
	const rects = unitElements(root, key).map((el) => el.getBoundingClientRect());
	if (rects.length === 0) return null;
	const top = Math.min(...rects.map((r) => r.top));
	const bottom = Math.max(...rects.map((r) => r.bottom));
	return { top, bottom, height: bottom - top };
}

function keyOf(unit: HTMLElement): string {
	return unit.getAttribute(ATTR.unit) ?? "";
}
