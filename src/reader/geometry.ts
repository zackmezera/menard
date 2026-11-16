/**
 * Scroll arithmetic for held level, the comfort band and scroll sync.
 * Pure. Owner: reader module. DESIGN.md §9.3–9.4.
 */

export interface ScrollerBox {
	scrollTop: number;
	/** Viewport top in client coordinates. */
	top: number;
	height: number;
	scrollHeight: number;
}

const READING_LINE = 0.35;
const COMFORT_TOP = 0.22;
const COMFORT_BOTTOM = 0.62;
/** Moves longer than this many viewports jump instead of animating. */
const SMOOTH_LIMIT = 1.5;

/** Reading line: 35% of the viewport height, in client coordinates. */
export function readingLine(box: ScrollerBox): number {
	return box.top + READING_LINE * box.height;
}

/** True when a client-y lies within 22%–62% of the viewport. */
export function inComfortBand(box: ScrollerBox, y: number): boolean {
	return y >= box.top + COMFORT_TOP * box.height && y <= box.top + COMFORT_BOTTOM * box.height;
}

/** True when a client-y lies within the viewport. */
export function inViewport(box: ScrollerBox, y: number): boolean {
	return y >= box.top && y <= box.top + box.height;
}

export function clampScrollTop(box: ScrollerBox, scrollTop: number): number {
	return Math.min(Math.max(scrollTop, 0), Math.max(box.scrollHeight - box.height, 0));
}

/** New scrollTop that puts an element whose top is at `elementTop` (client) at client-y `targetY`, clamped. */
export function scrollTopToPlace(box: ScrollerBox, elementTop: number, targetY: number): number {
	return clampScrollTop(box, box.scrollTop + elementTop - targetY);
}

/**
 * Scroll sync: the follower position for a fraction `f` through the
 * driver's unit, placing the partner's matching point at the reading line.
 * Between units, pass the gap between two partners as the span.
 */
export function followerScrollTop(follower: ScrollerBox, partnerTop: number, partnerHeight: number, fraction: number): number {
	const f = Math.min(Math.max(fraction, 0), 1);
	return scrollTopToPlace(follower, partnerTop + f * partnerHeight, readingLine(follower));
}

/** How far through [top, top + height] a client-y lies, 0–1. */
export function fractionThrough(top: number, height: number, y: number): number {
	if (height <= 0) return 0;
	return Math.min(Math.max((y - top) / height, 0), 1);
}

/** Smooth for moves within 1.5 viewports; instant for longer moves. */
export function isShortMove(box: ScrollerBox, scrollTop: number): boolean {
	return Math.abs(scrollTop - box.scrollTop) <= SMOOTH_LIMIT * box.height;
}
