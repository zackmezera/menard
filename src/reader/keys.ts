/**
 * Reading keys: a capture-phase keydown handler per window that acts only
 * on a session leaf in reading view. Owner: reader module. DESIGN.md §9.7.
 */
import type { MenardContext } from "../types";

export type KeyAction = "next" | "previous" | "next-unit" | "previous-unit" | "reveal" | "clear";

export interface KeyLike {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	isComposing: boolean;
}

export interface KeyContext {
	/** Stacked view in reveal mode with a concealed gloss. */
	revealable: boolean;
	hasCursor: boolean;
}

export interface KeyHandlers {
	/** The active session's key context, or null when the active leaf is not a session leaf in reading view. */
	context(): KeyContext | null;
	/** Performs the action; false if it did not apply. */
	act(action: KeyAction, repeat: boolean): boolean;
}

/** Focus inside these keeps every key for itself. */
const TYPING_TARGETS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], .modal-container, .menu, .prompt";
/** While one of these is open, keys belong to it. */
const OVERLAYS = ".modal-container, .menu";

/** Pure mapping of the §9.7 table: j/→ next, k/← previous, Shift variants by unit, Space reveal, Esc clear. */
export function keyAction(event: KeyLike, context: KeyContext): KeyAction | null {
	if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
	switch (event.key) {
		case "j":
			return "next";
		case "k":
			return "previous";
		case "J":
			return "next-unit";
		case "K":
			return "previous-unit";
		case "ArrowRight":
			return event.shiftKey ? "next-unit" : "next";
		case "ArrowLeft":
			return event.shiftKey ? "previous-unit" : "previous";
		case " ":
			return context.revealable && !event.shiftKey ? "reveal" : null;
		case "Escape":
			return context.hasCursor ? "clear" : null;
		default:
			return null;
	}
}

/**
 * Registers on the main window's document and on every popout's (workspace
 * "window-open"); a popout's listener goes when the popout closes, so a
 * closed window is not kept alive until the plugin unloads.
 */
export function registerReadingKeys(ctx: MenardContext, handlers: KeyHandlers): void {
	const listeners = new Map<Document, () => void>();
	const listen = (doc: Document): void => {
		if (listeners.has(doc)) return;
		const handler = (event: KeyboardEvent): void => onKeyDown(ctx, handlers, event, doc);
		doc.addEventListener("keydown", handler, { capture: true });
		listeners.set(doc, () => doc.removeEventListener("keydown", handler, { capture: true }));
	};
	const forget = (doc: Document): void => {
		listeners.get(doc)?.();
		listeners.delete(doc);
	};
	listen(ctx.app.workspace.containerEl.ownerDocument);
	ctx.owner.registerEvent(ctx.app.workspace.on("window-open", (_workspaceWindow, win) => listen(win.document)));
	ctx.owner.registerEvent(ctx.app.workspace.on("window-close", (_workspaceWindow, win) => forget(win.document)));
	ctx.owner.register(() => {
		for (const doc of [...listeners.keys()]) forget(doc);
	});
}

function onKeyDown(ctx: MenardContext, handlers: KeyHandlers, event: KeyboardEvent, doc: Document): void {
	if (!ctx.settings().readingKeys) return;
	if (isTypingTarget(event.target) || isTypingTarget(doc.activeElement) || doc.querySelector(OVERLAYS)) return;
	const context = handlers.context();
	if (!context) return;
	const action = keyAction(event, context);
	if (action && handlers.act(action, event.repeat)) {
		event.preventDefault();
		event.stopPropagation();
	}
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || !("instanceOf" in target)) return false;
	const node = target as Node;
	if (!node.instanceOf(HTMLElement)) return false;
	return node.isContentEditable || node.closest(TYPING_TARGETS) !== null;
}
