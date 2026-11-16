/**
 * Reading-cursor stepping over a pair's stops. Pure. Owner: reader module.
 * DESIGN.md §9.2.
 */
import type { CursorStop } from "../types";

/**
 * The stop `delta` steps from `from` by link, or to the first stop of the
 * next/previous unit by unit. Null at either end. A null `from` steps to
 * the first stop (delta 1) or the last stop (delta -1; by unit, the first
 * stop of the last unit). A `from` that is no longer a stop steps from the
 * nearest stop of its unit, or from nowhere when the unit is gone.
 */
export function stepStop(stops: readonly CursorStop[], from: CursorStop | null, by: "link" | "unit", delta: 1 | -1): CursorStop | null {
	if (stops.length === 0) return null;
	const index = from ? nearestIndex(stops, from) : -1;
	if (index < 0) {
		if (delta === 1) return stops[0] ?? null;
		const last = stops.length - 1;
		return (by === "unit" ? stops[firstOfUnit(stops, last)] : stops[last]) ?? null;
	}
	if (by === "link") return stops[index + delta] ?? null;

	const unit = stops[index]?.unit;
	if (delta === 1) {
		for (let i = index + 1; i < stops.length; i++) if (stops[i]?.unit !== unit) return stops[i] ?? null;
		return null;
	}
	const start = firstOfUnit(stops, index);
	return start === 0 ? null : (stops[firstOfUnit(stops, start - 1)] ?? null);
}

/**
 * The stop in `stops` that `stop` names: itself, or for a whole-unit
 * reference the unit's first stop. Null when it is not a stop (a flagged
 * translation-only link, a footnote, a unit that no longer exists).
 */
export function resolveStop(stops: readonly CursorStop[], stop: CursorStop): CursorStop | null {
	const exact = stops.find((s) => sameStop(s, stop));
	if (exact) return exact;
	return stop.link === null ? (stops.find((s) => s.unit === stop.unit) ?? null) : null;
}

/** "p12.3" for a link stop, "p12" for a whole-unit stop. */
export function stopAttr(stop: CursorStop): string {
	return stop.link === null ? stop.unit : `${stop.unit}.${stop.link}`;
}

/** Parses a `data-menard-link` value ("p12.3", "fn:en-3.1"); null if malformed. */
export function parseLinkAttr(value: string): CursorStop | null {
	const dot = value.lastIndexOf(".");
	if (dot <= 0) return null;
	const digits = value.slice(dot + 1);
	if (!/^[1-9]\d*$/.test(digits)) return null;
	return { unit: value.slice(0, dot), link: Number(digits) };
}

export function sameStop(a: CursorStop | null, b: CursorStop | null): boolean {
	if (a === null || b === null) return a === b;
	return a.unit === b.unit && a.link === b.link;
}

function nearestIndex(stops: readonly CursorStop[], from: CursorStop): number {
	const exact = stops.findIndex((s) => sameStop(s, from));
	if (exact >= 0) return exact;
	let fallback = -1;
	stops.forEach((s, i) => {
		if (s.unit !== from.unit) return;
		if (fallback < 0 || (from.link !== null && s.link !== null && s.link <= from.link)) fallback = i;
	});
	return fallback;
}

function firstOfUnit(stops: readonly CursorStop[], index: number): number {
	const unit = stops[index]?.unit;
	let i = index;
	while (i > 0 && stops[i - 1]?.unit === unit) i--;
	return i;
}
