/**
 * Obsidian's DOM additions (createSpan, createDiv, instanceOf, empty,
 * activeDocument), installed on happy-dom for render tests. Import this
 * first in every render test file that touches the DOM.
 */
type ElInfo = { cls?: string | string[]; attr?: Record<string, string | number | boolean | null>; text?: string };

function build<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, info?: ElInfo | string): HTMLElementTagNameMap[K] {
	const el = doc.createElement(tag);
	const o: ElInfo = typeof info === "string" ? { cls: info } : (info ?? {});
	if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")).filter(Boolean));
	for (const [key, value] of Object.entries(o.attr ?? {})) if (value !== null && value !== false) el.setAttribute(key, String(value));
	if (o.text !== undefined) el.textContent = o.text;
	return el;
}

const proto = Node.prototype as unknown as Record<string, unknown>;
proto.instanceOf = function (this: Node, type: abstract new (...args: never[]) => unknown): boolean {
	return Object.prototype.isPrototypeOf.call(type.prototype, this);
};
proto.createSpan = function (this: Node, info?: ElInfo | string): HTMLSpanElement {
	return this.appendChild(build(this.ownerDocument ?? (this as Document), "span", info));
};
proto.createDiv = function (this: Node, info?: ElInfo | string): HTMLDivElement {
	return this.appendChild(build(this.ownerDocument ?? (this as Document), "div", info));
};
proto.empty = function (this: Node): void {
	while (this.firstChild) this.removeChild(this.firstChild);
};

// Under happy-dom, `window` is the global object, so these become bare globals.
const globals = window as unknown as Record<string, unknown>;
globals.createDiv = (info?: ElInfo | string): HTMLDivElement => build(document, "div", info);
globals.createSpan = (info?: ElInfo | string): HTMLSpanElement => build(document, "span", info);
globals.createFragment = (): DocumentFragment => document.createDocumentFragment();
globals.activeDocument = document;
globals.activeWindow = window;

/** Parses trusted test markup into a detached section div, as reading view hands it over. */
export function section(html: string): HTMLDivElement {
	const parsed = new DOMParser().parseFromString(`<body>${html.trim()}</body>`, "text/html");
	const div = document.createElement("div");
	for (const node of Array.from(parsed.body.childNodes)) div.appendChild(document.importNode(node, true));
	return div;
}

type Setter = (this: Element, value: string) => void;

/** Counts innerHTML and outerHTML writes on any element while armed. */
export function htmlSetterSpy(): { arm(): void; calls(): number; installed(): number; reset(): void; restore(): void } {
	const saved: { target: object; name: string; descriptor: PropertyDescriptor }[] = [];
	let armed = false;
	let calls = 0;
	for (const target of [Element.prototype, HTMLElement.prototype]) {
		for (const name of ["innerHTML", "outerHTML"]) {
			const descriptor = Object.getOwnPropertyDescriptor(target, name);
			if (!descriptor?.set) continue;
			const original = Reflect.get(descriptor, "set") as Setter;
			saved.push({ target, name, descriptor });
			Object.defineProperty(target, name, {
				...descriptor,
				set(this: Element, value: string) {
					if (armed) calls++;
					Reflect.apply(original, this, [value]);
				},
			});
		}
	}
	return {
		arm: () => {
			armed = true;
		},
		calls: () => calls,
		installed: () => saved.length,
		reset: () => {
			calls = 0;
		},
		restore: () => {
			for (const { target, name, descriptor } of saved) Object.defineProperty(target, name, descriptor);
		},
	};
}
