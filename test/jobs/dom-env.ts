/**
 * The Obsidian DOM helpers the jobs' UI uses (createFragment, createEl,
 * createSpan, createDiv, addClass, empty, setText), installed on happy-dom. Import
 * this first in jobs test files that touch the DOM.
 */
import { vi } from "vitest";

type ElInfo = { cls?: string | string[]; text?: string; type?: string; value?: string; attr?: Record<string, string> };

function build<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, info?: ElInfo | string): HTMLElementTagNameMap[K] {
	const el = doc.createElement(tag);
	const o: ElInfo = typeof info === "string" ? { cls: info } : (info ?? {});
	const classes = Array.isArray(o.cls) ? o.cls : (o.cls ?? "").split(" ");
	el.classList.add(...classes.filter((c) => c !== ""));
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type !== undefined) el.setAttribute("type", o.type);
	if (o.value !== undefined) (el as unknown as HTMLInputElement).value = o.value;
	for (const [key, value] of Object.entries(o.attr ?? {})) el.setAttribute(key, value);
	return el;
}

const proto = Node.prototype as unknown as Record<string, unknown>;
proto.createEl = function (this: Node, tag: keyof HTMLElementTagNameMap, info?: ElInfo | string): HTMLElement {
	return this.appendChild(build(this.ownerDocument ?? document, tag, info));
};
proto.createSpan = function (this: Node, info?: ElInfo | string): HTMLElement {
	return this.appendChild(build(this.ownerDocument ?? document, "span", info));
};
proto.createDiv = function (this: Node, info?: ElInfo | string): HTMLElement {
	return this.appendChild(build(this.ownerDocument ?? document, "div", info));
};
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto.addClass = function (this: Element, ...classes: string[]): void {
	this.classList.add(...classes);
};
proto.empty = function (this: Node): void {
	while (this.firstChild) this.removeChild(this.firstChild);
};
proto.setText = function (this: Node, text: string): void {
	this.textContent = text;
};

vi.stubGlobal("createFragment", (callback?: (fragment: DocumentFragment) => void): DocumentFragment => {
	const fragment = document.createDocumentFragment();
	callback?.(fragment);
	return fragment;
});
