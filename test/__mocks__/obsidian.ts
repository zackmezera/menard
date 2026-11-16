/**
 * Stand-in for the `obsidian` module under vitest (aliased in
 * vitest.config.ts). It covers every runtime export Menard's modules use, so
 * module work never needs to edit this shared file; module-specific fakes
 * (an in-memory vault, a fake App) belong in that module's own test folder.
 * Behaviour is minimal and synchronous; nothing here imitates Obsidian's
 * rendering beyond what a test asserts on.
 */
import { StateField } from "@codemirror/state";

type Cleanup = () => void;

export interface EventRef {
	events: Events;
	name: string;
	callback: (...args: unknown[]) => unknown;
}

export class Events {
	private handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();

	on(name: string, callback: (...args: unknown[]) => unknown): EventRef {
		let set = this.handlers.get(name);
		if (!set) {
			set = new Set();
			this.handlers.set(name, set);
		}
		set.add(callback);
		return { events: this, name, callback };
	}

	off(name: string, callback: (...args: unknown[]) => unknown): void {
		this.handlers.get(name)?.delete(callback);
	}

	offref(ref: EventRef): void {
		this.off(ref.name, ref.callback);
	}

	trigger(name: string, ...args: unknown[]): void {
		for (const callback of this.handlers.get(name) ?? []) callback(...args);
	}
}

export class Component {
	private cleanups: Cleanup[] = [];
	private children: Component[] = [];
	private loaded = false;

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
		for (const child of this.children) child.load();
	}

	onload(): void {}

	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children.splice(0)) child.unload();
		for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		if (this.loaded) child.load();
		return child;
	}

	removeChild<T extends Component>(child: T): T {
		this.children = this.children.filter((c) => c !== child);
		child.unload();
		return child;
	}

	register(cleanup: Cleanup): void {
		this.cleanups.push(cleanup);
	}

	registerEvent(ref: EventRef): void {
		this.register(() => ref.events.offref(ref));
	}

	registerDomEvent(
		el: EventTarget,
		type: string,
		callback: (event: Event) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void {
		el.addEventListener(type, callback, options);
		this.register(() => el.removeEventListener(type, callback, options));
	}

	registerInterval(id: number): number {
		this.register(() => clearInterval(id));
		return id;
	}
}

function makeDiv(): HTMLElement {
	return typeof document === "undefined" ? ({} as HTMLElement) : document.createElement("div");
}

export class Plugin extends Component {
	constructor(
		public app: unknown,
		public manifest: unknown,
	) {
		super();
	}

	addCommand(command: unknown): unknown {
		return command;
	}

	addSettingTab(_tab: unknown): void {}

	addStatusBarItem(): HTMLElement {
		return makeDiv();
	}

	registerMarkdownPostProcessor(processor: unknown): unknown {
		return processor;
	}

	registerEditorExtension(_extension: unknown): void {}

	async loadData(): Promise<unknown> {
		return null;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

export const MarkdownRenderer = {
	/** Renders each blank-line-separated block as a <p> of plain text. */
	async render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath: string, _component: Component): Promise<void> {
		for (const block of markdown.split(/\n{2,}/)) {
			const p = el.ownerDocument.createElement("p");
			p.textContent = block;
			el.appendChild(p);
		}
	},
};

export class Notice {
	noticeEl: HTMLElement = makeDiv();

	constructor(
		public message: string | DocumentFragment,
		public duration?: number,
	) {}

	setMessage(message: string | DocumentFragment): this {
		this.message = message;
		return this;
	}

	hide(): void {}
}

export const apiVersion = "1.13.0";

export const Platform = {
	isDesktop: true,
	isDesktopApp: true,
	isMobile: false,
	isMobileApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isIosApp: false,
	isAndroidApp: false,
};

export class TAbstractFile {
	name: string;
	parent: TFolder | null = null;

	constructor(public path: string) {
		this.name = path.split("/").pop() ?? path;
	}
}

export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	stat = { ctime: 0, mtime: 0, size: 0 };

	constructor(path: string) {
		super(path);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class Modal extends Component {
	contentEl: HTMLElement = makeDiv();
	titleEl: HTMLElement = makeDiv();
	modalEl: HTMLElement = makeDiv();

	constructor(public app: unknown) {
		super();
	}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {}

	onClose(): void {}

	setTitle(_title: string): this {
		return this;
	}
}

export class SuggestModal<T> extends Modal {
	getSuggestions(_query: string): T[] | Promise<T[]> {
		return [];
	}

	renderSuggestion(_value: T, _el: HTMLElement): void {}

	onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}

	setPlaceholder(_placeholder: string): void {}
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {
	getItems(): T[] {
		return [];
	}

	getItemText(_item: T): string {
		return "";
	}

	onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class Setting {
	constructor(public containerEl: HTMLElement) {}

	setName(_name: string): this {
		return this;
	}

	setDesc(_desc: string | DocumentFragment): this {
		return this;
	}

	setHeading(): this {
		return this;
	}

	addButton(_cb: (button: unknown) => unknown): this {
		return this;
	}
}

export abstract class SettingTab {
	containerEl: HTMLElement = makeDiv();

	constructor(public app: unknown) {}

	getSettingDefinitions(): unknown[] {
		return [];
	}

	update(): void {}

	refreshDomState(): void {}

	display(): void {}

	hide(): void {}
}

export class PluginSettingTab extends SettingTab {
	constructor(
		app: unknown,
		public plugin: unknown,
	) {
		super(app);
	}
}

export class MarkdownView {
	file: TFile | null = null;

	getMode(): "source" | "preview" {
		return "preview";
	}
}

export class WorkspaceLeaf {
	view: unknown = null;
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "")
		.normalize("NFC");
}

export function debounce<T extends unknown[]>(fn: (...args: T) => unknown, wait = 0): ((...args: T) => void) & { cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const debounced = (...args: T): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
	debounced.cancel = (): void => {
		if (timer !== undefined) clearTimeout(timer);
	};
	return debounced;
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

/** The import module injects its own converter in tests; this only satisfies the import. */
export function htmlToMarkdown(html: string | HTMLElement): string {
	return typeof html === "string" ? html : (html.textContent ?? "");
}

export function loadPdfJs(): Promise<never> {
	return Promise.reject(new Error("pdf.js is not available in tests"));
}

/** App-provided state fields in Obsidian; tests set their values through EditorState.create. */
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => true,
	update: (value) => value,
});

export const editorInfoField = StateField.define<{ file: TFile | null }>({
	create: () => ({ file: null }),
	update: (value) => value,
});
