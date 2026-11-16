/**
 * The last reading-cursor stop per source note, so a pair reopens where the
 * reader left it. Kept in plugin data, never in the notes; a small LRU.
 * Owner: reader module. DESIGN.md §9.2.
 */
import type { CursorStop } from "../types";

/** The plugin-data key the positions are stored under, beside the settings. */
export const POSITIONS_KEY = "readingPositions";
/** Source notes remembered; the least recently read is dropped first. */
export const POSITIONS_LIMIT = 200;
/** Cursor moves come in bursts; one write after they settle. */
const SAVE_DELAY_MS = 2000;

/** What a session needs: the stop to restore, and where to record a new one. */
export interface PositionStore {
	get(sourcePath: string): CursorStop | null;
	set(sourcePath: string, stop: CursorStop): void;
}

export class ReadingPositions implements PositionStore {
	/** Least recently set first. */
	private readonly stops = new Map<string, CursorStop>();
	private timer: number | null = null;

	/** `save` persists `toJSON()`; it runs at most once per burst of moves. */
	constructor(
		private readonly save: () => void,
		private readonly limit = POSITIONS_LIMIT,
		private readonly delayMs = SAVE_DELAY_MS,
	) {}

	/** Replaces the positions with stored data; anything malformed is skipped. */
	load(stored: unknown): void {
		this.stops.clear();
		if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
		for (const [path, value] of Object.entries(stored as Record<string, unknown>)) {
			const stop = parseStop(value);
			if (stop) this.stops.set(path, stop);
		}
		this.trim();
	}

	get(sourcePath: string): CursorStop | null {
		return this.stops.get(sourcePath) ?? null;
	}

	set(sourcePath: string, stop: CursorStop): void {
		const known = this.stops.get(sourcePath);
		const last = [...this.stops.keys()].pop();
		if (known && known.unit === stop.unit && known.link === stop.link && last === sourcePath) return;
		this.stops.delete(sourcePath);
		this.stops.set(sourcePath, { unit: stop.unit, link: stop.link });
		this.trim();
		this.schedule();
	}

	/** Oldest first, as stored. */
	toJSON(): Record<string, CursorStop> {
		return Object.fromEntries(this.stops);
	}

	/** Writes a pending change now (on unload). */
	flush(): void {
		if (this.timer === null) return;
		window.clearTimeout(this.timer);
		this.timer = null;
		this.save();
	}

	private schedule(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.save();
		}, this.delayMs);
	}

	private trim(): void {
		while (this.stops.size > this.limit) {
			const oldest = this.stops.keys().next().value;
			if (oldest === undefined) break;
			this.stops.delete(oldest);
		}
	}
}

function parseStop(value: unknown): CursorStop | null {
	if (typeof value !== "object" || value === null) return null;
	const { unit, link } = value as { unit?: unknown; link?: unknown };
	if (typeof unit !== "string" || unit === "") return null;
	if (link === null) return { unit, link: null };
	return typeof link === "number" && Number.isInteger(link) && link >= 1 ? { unit, link } : null;
}
