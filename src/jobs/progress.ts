/**
 * A persistent Notice with a Cancel button, mirrored in the status bar, and
 * the user-facing copy for errors. Owner: jobs module. DESIGN.md §7.4, §11.
 */
import { Notice } from "obsidian";
import { isMenardError } from "../errors";

/** The notice is rebuilt at most this often (4 Hz). */
const MIN_REPAINT_MS = 250;

/** A button shown with the final summary. */
export interface NoticeAction {
	label: string;
	run(): void;
}

/** What a job reports progress to; ProgressNotice in the app, a recorder in tests. */
export interface ProgressSink {
	update(done: number, failed: number, running: number, total: number): void;
	finish(summary: string, action?: NoticeAction): void;
	/** Removes the progress without a summary; later calls do nothing. */
	close(): void;
}

export class ProgressNotice implements ProgressSink {
	private notice: Notice | null = null;
	/** Whether the notice was seen in the document, so its removal means the user dismissed it. */
	private attached = false;
	private lastPaint = 0;
	private timer: number | null = null;
	private latest: { done: number; failed: number; running: number; total: number } | null = null;
	private closed = false;

	constructor(
		private readonly title: string,
		private readonly onCancel: () => void,
		private readonly statusBar: HTMLElement | null,
	) {}

	/** "Translating @x: 23 of 74 · 2 running · 1 failed"; throttled to 4 Hz. */
	update(done: number, failed: number, running: number, total: number): void {
		if (this.closed) return;
		this.latest = { done, failed, running, total };
		if (this.timer !== null) return;
		const wait = this.lastPaint + MIN_REPAINT_MS - Date.now();
		if (wait <= 0) this.paint();
		else this.timer = window.setTimeout(() => this.paint(), wait);
	}

	/** Replaces the progress with a summary that stays until dismissed. */
	finish(summary: string, action?: NoticeAction): void {
		if (this.closed) return;
		this.clearTimer();
		this.statusBar?.setText("");
		const fragment = createFragment((frag) => {
			frag.createSpan({ text: summary });
			if (action !== undefined) {
				const button = frag.createEl("button", { text: action.label, cls: "menard-notice-action" });
				button.addEventListener("click", () => action.run());
			}
		});
		this.show(fragment);
	}

	close(): void {
		this.closed = true;
		this.clearTimer();
		this.statusBar?.setText("");
		this.notice?.hide();
		this.notice = null;
	}

	private paint(): void {
		this.clearTimer();
		const latest = this.latest;
		if (latest === null) return;
		this.lastPaint = Date.now();
		const text = progressText(this.title, latest.done, latest.failed, latest.running, latest.total);
		this.statusBar?.setText(text);
		const fragment = createFragment((frag) => {
			frag.createSpan({ text });
			const cancel = frag.createEl("button", { text: "Cancel", cls: "menard-notice-action" });
			cancel.addEventListener("click", (event) => {
				event.stopPropagation();
				this.onCancel();
			});
		});
		this.show(fragment);
	}

	/** Updates the notice, or shows a new one when the user dismissed it by clicking. */
	private show(fragment: DocumentFragment): void {
		if (this.notice !== null && this.attached && !isShown(this.notice)) this.notice = null;
		if (this.notice === null) this.notice = new Notice(fragment, 0);
		else this.notice.setMessage(fragment);
		this.attached = isShown(this.notice);
	}

	private clearTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}

/** True while the notice is in the document; Obsidian removes it when the user clicks it away. */
function isShown(notice: Notice): boolean {
	// Read defensively: stand-ins for Notice may lack containerEl.
	const container = notice.containerEl as HTMLElement | undefined;
	return container?.isConnected === true;
}

/** The progress line: "Translating @x: 23 of 74 · 2 running · 1 failed". */
export function progressText(title: string, done: number, failed: number, running: number, total: number): string {
	let text = `${title}: ${done} of ${total}`;
	if (running > 0) text += ` · ${running} running`;
	if (failed > 0) text += ` · ${failed} failed`;
	return text;
}

/** The notice text for an error, per DESIGN.md §11. Never a stack trace. */
export function messageFor(error: unknown): string {
	if (!isMenardError(error)) return error instanceof Error ? error.message : String(error);
	switch (error.code) {
		case "cli-not-found":
			return "Claude Code was not found. Set its path in Menard's options.";
		case "cli-not-logged-in":
			return "Claude Code is not signed in for apps started outside a terminal. Run `claude` once in a terminal and sign in, then try again.";
		case "cli-rate-limited":
			return "Claude usage limit reached. Try again later.";
		case "cli-timeout":
			return "Claude Code did not answer in time. If a keychain prompt appeared, allow it and try again.";
		case "desktop-only":
			return "Translation needs the desktop app.";
		case "write-conflict":
		case "backup-stale":
			return "The note changed while writing; run again.";
		case "not-owned":
		case "insert-only-violation":
			return "Menard stopped before changing the note because a safety check failed. Nothing was written. Please report this.";
		case "backup-failed":
			return "Menard could not save a backup, so nothing was changed.";
		case "pair-not-reciprocal":
			return "This note links to a translation that does not link back. Run Check alignment to repair.";
		case "reserved-character":
			return "This paragraph contains ⟦ or ⟧, which Menard reserves; it was skipped.";
		case "cancelled":
			return "Cancelled.";
		default:
			return error.message;
	}
}
