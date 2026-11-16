/**
 * Native reading-view leaves: the facing split, leaf tags, and the one place
 * that touches reading-view internals (spike S1). Never detaches leaves.
 * Owner: reader module. DESIGN.md §9.3, ADR 0007.
 */
import { MarkdownView } from "obsidian";
import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { ATTR, CLS } from "../constants";
import type { PairLink, Side } from "../types";
import type { ScrollerBox } from "./geometry";

/** A leaf showing a note in reading view. Looked up on demand, never stored by sessions. */
export interface ReadingPane {
	leaf: WorkspaceLeaf;
	path: string;
	/** The view's outer element, which carries Menard's leaf tags. */
	leafEl: HTMLElement;
	/** The reading view's root; rendered sections are inside it. */
	content: HTMLElement;
	/** The element that scrolls. */
	scroller: HTMLElement;
	/** Scrolls so a source line (0-based) is at the top, rendering its section. */
	applyScroll(line: number): void;
	/** True when the pane is on screen (not a background tab). */
	visible(): boolean;
}

// ─── Reading-view access (spike S1) ─────────────────────────────────────────

/** The reading pane of a leaf, or null when the leaf is not a Markdown note in reading view. */
export function readingPane(leaf: WorkspaceLeaf): ReadingPane | null {
	const view = leaf.view;
	if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== "preview") return null;
	const preview = view.previewMode;
	const content = preview.containerEl;
	const scroller = content.querySelector<HTMLElement>(".markdown-preview-view") ?? content;
	return {
		leaf,
		path: view.file.path,
		leafEl: view.containerEl,
		content,
		scroller,
		applyScroll: (line) => preview.applyScroll(line),
		visible: () => view.containerEl.isShown(),
	};
}

/** The file a leaf's Markdown view shows, in any mode. */
export function markdownFile(leaf: WorkspaceLeaf): TFile | null {
	return leaf.view instanceof MarkdownView ? leaf.view.file : null;
}

export function scrollerBox(scroller: HTMLElement): ScrollerBox {
	return {
		scrollTop: scroller.scrollTop,
		top: scroller.getBoundingClientRect().top,
		height: scroller.clientHeight,
		scrollHeight: scroller.scrollHeight,
	};
}

// ─── Leaf tags ──────────────────────────────────────────────────────────────

/** Marks a leaf's role in a facing session, or clears it with null. */
export function tagFacing(leafEl: HTMLElement, role: Side | null): void {
	if (role === null) leafEl.removeAttribute(ATTR.role);
	else if (leafEl.getAttribute(ATTR.role) !== role) leafEl.setAttribute(ATTR.role, role);
	if (leafEl.classList.contains(CLS.facing) !== (role !== null)) leafEl.classList.toggle(CLS.facing, role !== null);
}

export function tagStacked(leafEl: HTMLElement, on: boolean): void {
	if (leafEl.classList.contains(CLS.stacked) !== on) leafEl.classList.toggle(CLS.stacked, on);
}

// ─── Opening the facing split ───────────────────────────────────────────────

/**
 * Source on the left in `leaf`, translation on the right, both in reading
 * view. Reuses a leaf in the same window already showing the translation.
 */
export async function openFacingView(app: App, pair: PairLink, leaf: WorkspaceLeaf): Promise<void> {
	const preview = { state: { mode: "preview" } };
	if (!readingPane(leaf) || markdownFile(leaf)?.path !== pair.source.path) {
		await leaf.openFile(pair.source, preview);
	}
	const partner =
		findLeaf(app, (other) => other !== leaf && other.getContainer() === leaf.getContainer() && markdownFile(other)?.path === pair.target.path) ??
		splitRight(app, leaf);
	if (!readingPane(partner)) await partner.openFile(pair.target, { ...preview, active: false });
}

export function findLeaf(app: App, test: (leaf: WorkspaceLeaf) => boolean): WorkspaceLeaf | null {
	let found: WorkspaceLeaf | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (!found && test(leaf)) found = leaf;
	});
	return found;
}

function splitRight(app: App, leaf: WorkspaceLeaf): WorkspaceLeaf {
	app.workspace.setActiveLeaf(leaf, { focus: false });
	return app.workspace.getLeaf("split", "vertical");
}
