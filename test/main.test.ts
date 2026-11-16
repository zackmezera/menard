// @vitest-environment happy-dom
import { Events, MarkdownView, TFile } from "obsidian";
import type { App, Command, PluginManifest } from "obsidian";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isMenardError } from "../src/errors";
import { JobController } from "../src/jobs/controller";
import { detectClaude } from "../src/llm/detect";
import MenardPlugin from "../src/main";
import { MenardSettingTab } from "../src/settings-tab";
import { SessionManager } from "../src/reader/sessions";
import type { DetectResult, PairModel, PairUnit } from "../src/types";
import { PairStore } from "../src/vault/pairs";

const backends = vi.hoisted(() => [] as { resolvePath: () => Promise<string>; onMissing: () => void; killAll: ReturnType<typeof vi.fn> }[]);

vi.mock("../src/llm/claude-cli", () => ({
	ClaudeCliBackend: class {
		readonly name = "fake";
		readonly killAll = vi.fn();
		constructor(
			readonly resolvePath: () => Promise<string>,
			readonly onMissing: () => void,
		) {
			backends.push(this);
		}
		run(): Promise<never> {
			return Promise.reject(new Error("not used"));
		}
	},
}));

vi.mock("../src/llm/detect", () => ({ detectClaude: vi.fn() }));

/** Every command in DESIGN.md §12.2. */
const COMMAND_IDS = [
	"translate-note",
	"align-with-translation",
	"split-combined-note",
	"translate-folder",
	"retranslate-paragraph",
	"realign-paragraph",
	"check-alignment",
	"cancel-job",
	"check-claude",
	"open-facing-view",
	"toggle-stacked-view",
	"next-sentence",
	"previous-sentence",
	"next-paragraph",
	"previous-paragraph",
	"reveal-translation",
	"toggle-reveal-mode",
	"clear-reading-cursor",
	"copy-paragraph-link",
	"report-problem",
	"import-epub",
	"import-pdf-text",
	"import-pdf-pair",
	"add-pdf-page-markers",
];

/** Handlers still registered on an Events instance of the shared mock. */
function listenerCount(events: Events): number {
	const handlers = (events as unknown as { handlers: Map<string, Set<unknown>> }).handlers;
	let count = 0;
	for (const set of handlers.values()) count += set.size;
	return count;
}

class FakeWorkspace extends Events {
	readonly containerEl = document.createElement("div");
	activeFile: TFile | null = null;
	readonly updateOptions = vi.fn();
	iterateAllLeaves(): void {}
	getActiveViewOfType(): null {
		return null;
	}
	getActiveFile(): TFile | null {
		return this.activeFile;
	}
}

class FakeMetadataCache extends Events {
	getFileCache(): null {
		return null;
	}
	getFirstLinkpathDest(): null {
		return null;
	}
}

class FakeVault extends Events {
	readonly configDir = ".config-dir";
	getFileByPath(): null {
		return null;
	}
}

interface Harness {
	plugin: MenardPlugin;
	workspace: FakeWorkspace;
	metadataCache: FakeMetadataCache;
	vault: FakeVault;
	commands: Command[];
	extensions: unknown[][];
	stored: unknown;
}

function harness(stored: unknown = null): Harness {
	const workspace = new FakeWorkspace();
	document.body.appendChild(workspace.containerEl);
	const metadataCache = new FakeMetadataCache();
	const vault = new FakeVault();
	const app = { workspace, metadataCache, vault } as unknown as App;
	const plugin = new MenardPlugin(app, { id: "menard" } as PluginManifest);
	const h: Harness = { plugin, workspace, metadataCache, vault, commands: [], extensions: [], stored };
	vi.spyOn(plugin, "addCommand").mockImplementation((command: Command) => {
		h.commands.push(command);
		return command;
	});
	vi.spyOn(plugin, "registerEditorExtension").mockImplementation((extension) => {
		h.extensions.push(extension as unknown[]);
	});
	vi.spyOn(plugin, "loadData").mockImplementation(async () => h.stored);
	vi.spyOn(plugin, "saveData").mockImplementation(async (data: unknown) => {
		h.stored = structuredClone(data);
	});
	return h;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function loaded(stored: unknown = null): Promise<Harness> {
	const h = harness(stored);
	h.plugin.load();
	await flush();
	return h;
}

function command(h: Harness, id: string): Command {
	const found = h.commands.find((c) => c.id === id);
	if (!found) throw new Error(`No command ${id}`);
	return found;
}

beforeAll(() => {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	proto.toggleClass = function (this: Element, cls: string, on: boolean) {
		this.classList.toggle(cls, on);
	};
	proto.removeClass = function (this: Element, cls: string) {
		this.classList.remove(cls);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	};
	(window as unknown as Record<string, unknown>).activeDocument = document;
});

beforeEach(() => {
	backends.length = 0;
	vi.mocked(detectClaude).mockReset();
	document.body.replaceChildren();
	document.body.className = "";
});

afterEach(() => vi.restoreAllMocks());

describe("MenardPlugin onload", () => {
	it("registers every command of DESIGN §12.2, without hotkeys", async () => {
		const h = await loaded();
		expect(h.commands.map((c) => c.id).sort()).toEqual([...COMMAND_IDS].sort());
		for (const c of h.commands) {
			expect(c.hotkeys).toBeUndefined();
			expect(c.id.startsWith("menard")).toBe(false);
			expect(c.name.toLowerCase()).not.toMatch(/menard|command/);
			expect(c.checkCallback ?? c.callback).toBeTypeOf("function");
		}
		h.plugin.unload();
	});

	it("merges stored settings over the defaults", async () => {
		const h = await loaded({ model: "opus", concurrency: 3 });
		expect(h.plugin.settings.model).toBe("opus");
		expect(h.plugin.settings.concurrency).toBe(3);
		expect(h.plugin.settings.backupCount).toBe(30);
		h.plugin.unload();
	});

	it("adds the settings tab and the editor extension", async () => {
		const h = harness();
		const addTab = vi.spyOn(h.plugin, "addSettingTab");
		h.plugin.load();
		await flush();
		expect(addTab).toHaveBeenCalledWith(expect.any(MenardSettingTab));
		expect(h.extensions).toHaveLength(1);
		expect(h.extensions[0]).toHaveLength(1);
		h.plugin.unload();
	});

	it("offers file and reading commands only when they apply, and the connection check always", async () => {
		const h = await loaded();
		for (const id of ["translate-note", "open-facing-view", "cancel-job", "next-sentence", "copy-paragraph-link", "retranslate-paragraph"]) {
			expect(command(h, id).checkCallback?.(true)).toBe(false);
		}
		expect(command(h, "check-claude").callback).toBeTypeOf("function");

		h.workspace.activeFile = new (TFile as unknown as new (path: string) => TFile)("Texts/@note.md");
		expect(command(h, "translate-note").checkCallback?.(true)).toBe(true);
		expect(command(h, "check-alignment").checkCallback?.(true)).toBe(false);
		h.plugin.unload();
	});
});

describe("MenardPlugin unit and reading commands", () => {
	const file = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);

	it("does not offer Re-translate paragraph on a heading line of the source", async () => {
		const h = await loaded();
		const source = file("Texts/@x.md");
		const pair = { source, target: file("Texts/@x (EN).md") };
		const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
			file: source,
			getMode: () => "source",
			editor: { getCursor: () => ({ line: 0, ch: 0 }) },
		});
		h.workspace.getActiveViewOfType = (() => view) as never;
		vi.spyOn(PairStore.prototype, "resolve").mockReturnValue({ pair, side: "source" });
		let kind: "heading" | "paragraph" = "heading";
		const unit = (): PairUnit => ({ key: kind === "heading" ? "h:1" : "p1", kind, source: {} as never, target: {} as never, map: null, pending: null });
		vi.spyOn(PairStore.prototype, "peek").mockReturnValue({ unitAtLine: unit, unit } as unknown as PairModel);
		expect(command(h, "retranslate-paragraph").checkCallback?.(true)).toBe(false);
		kind = "paragraph";
		expect(command(h, "retranslate-paragraph").checkCallback?.(true)).toBe(true);
		h.plugin.unload();
	});

	it("offers the reveal commands only where they act, not in any session", async () => {
		const h = await loaded();
		vi.spyOn(SessionManager.prototype, "hasActiveSession").mockReturnValue(true);
		expect(command(h, "next-sentence").checkCallback?.(true)).toBe(true);
		expect(command(h, "reveal-translation").checkCallback?.(true)).toBe(false);
		expect(command(h, "toggle-reveal-mode").checkCallback?.(true)).toBe(false);
		vi.spyOn(SessionManager.prototype, "canReveal").mockReturnValue(true);
		vi.spyOn(SessionManager.prototype, "canToggleRevealMode").mockReturnValue(true);
		expect(command(h, "reveal-translation").checkCallback?.(true)).toBe(true);
		expect(command(h, "toggle-reveal-mode").checkCallback?.(true)).toBe(true);
		h.plugin.unload();
	});
});

describe("MenardPlugin settings", () => {
	it("keeps reading positions in plugin data beside the settings, not in the settings", async () => {
		const stop = { unit: "p3", link: 2 };
		const h = await loaded({ model: "opus", readingPositions: { "Collections/Texts/@a.md": stop } });
		expect(h.plugin.settings.model).toBe("opus");
		expect("readingPositions" in h.plugin.settings).toBe(false);
		await h.plugin.saveSettings();
		expect(h.stored).toMatchObject({ model: "opus", readingPositions: { "Collections/Texts/@a.md": stop } });
		h.plugin.unload();
	});

	it("saves, rebuilds the editor extension in place, and updates editor options", async () => {
		const h = await loaded();
		const array = h.extensions[0];
		const before = array?.[0];
		h.plugin.settings.hideBlockIds = false;
		await h.plugin.saveSettings();
		expect((h.stored as { hideBlockIds: boolean }).hideBlockIds).toBe(false);
		expect(h.extensions).toHaveLength(1);
		expect(array).toHaveLength(1);
		expect(array?.[0]).not.toBe(before);
		expect(h.workspace.updateOptions).toHaveBeenCalledTimes(1);
		// Live Preview hides ids with decorations; no class lands on whichever window happens to be active.
		expect(document.body.className).toBe("");
		h.plugin.unload();
	});

	it("fades other sentences through a body class and opacity variable, and clears both on unload", async () => {
		const h = await loaded();
		expect(document.body.classList.contains("menard-dim-inactive")).toBe(false);
		h.plugin.settings.dimInactive = true;
		h.plugin.settings.dimOpacity = 30;
		await h.plugin.saveSettings();
		expect(document.body.classList.contains("menard-dim-inactive")).toBe(true);
		expect(document.body.style.getPropertyValue("--menard-dim-opacity")).toBe("0.3");
		h.plugin.unload();
		expect(document.body.classList.contains("menard-dim-inactive")).toBe(false);
	});

	it("tells the pair store and the reader that the settings changed (#27)", async () => {
		const h = await loaded();
		const pairs = vi.spyOn(PairStore.prototype, "settingsChanged");
		const reader = vi.spyOn(SessionManager.prototype, "settingsChanged");
		h.plugin.settings.textStartHeading = "Text";
		await h.plugin.saveSettings();
		expect(pairs).toHaveBeenCalledTimes(1);
		expect(reader).toHaveBeenCalledTimes(1);
		expect(pairs.mock.invocationCallOrder[0]).toBeLessThan(reader.mock.invocationCallOrder[0] ?? 0);
		h.plugin.unload();
	});
});

describe("MenardPlugin claude path", () => {
	const found = (path: string | null): DetectResult => ({ path, via: path ? "candidate" : null, tried: ["/a/claude", "/b/claude"] });

	it("detects once per path setting and again after the setting changes", async () => {
		vi.mocked(detectClaude).mockResolvedValue(found("/home/u/.local/bin/claude"));
		const h = await loaded();
		const backend = backends[0];
		if (!backend) throw new Error("no backend");
		await expect(backend.resolvePath()).resolves.toBe("/home/u/.local/bin/claude");
		await backend.resolvePath();
		expect(detectClaude).toHaveBeenCalledTimes(1);
		expect(detectClaude).toHaveBeenCalledWith("", { probeShell: false });

		h.plugin.settings.claudePath = "/opt/claude";
		vi.mocked(detectClaude).mockResolvedValue({ path: "/opt/claude", via: "setting", tried: ["/opt/claude"] });
		await expect(backend.resolvePath()).resolves.toBe("/opt/claude");
		expect(detectClaude).toHaveBeenLastCalledWith("/opt/claude", { probeShell: false });
		h.plugin.unload();
	});

	it("searches again once the backend reports that the found path cannot be started", async () => {
		vi.mocked(detectClaude).mockResolvedValue(found("/opt/homebrew/bin/claude"));
		const h = await loaded();
		const backend = backends[0];
		if (!backend) throw new Error("no backend");
		await backend.resolvePath();
		await backend.resolvePath();
		expect(detectClaude).toHaveBeenCalledTimes(1);
		backend.onMissing();
		vi.mocked(detectClaude).mockResolvedValue(found("/Users/u/.local/bin/claude"));
		await expect(backend.resolvePath()).resolves.toBe("/Users/u/.local/bin/claude");
		expect(detectClaude).toHaveBeenCalledTimes(2);
		h.plugin.unload();
	});

	it("throws cli-not-found with the paths tried, and searches again next time", async () => {
		vi.mocked(detectClaude).mockResolvedValue(found(null));
		const h = await loaded();
		const backend = backends[0];
		if (!backend) throw new Error("no backend");
		const error: unknown = await backend.resolvePath().catch((e: unknown) => e);
		expect(isMenardError(error, "cli-not-found")).toBe(true);
		expect((error as Error).message).toContain("/a/claude, /b/claude");
		await backend.resolvePath().catch(() => undefined);
		expect(detectClaude).toHaveBeenCalledTimes(2);
		h.plugin.unload();
	});
});

describe("MenardPlugin onunload", () => {
	it("kills children, disposes the jobs and leaves no listeners behind", async () => {
		const dispose = vi.spyOn(JobController.prototype, "dispose");
		const added = vi.spyOn(document, "addEventListener");
		const removed = vi.spyOn(document, "removeEventListener");
		const h = await loaded();
		expect(listenerCount(h.workspace)).toBeGreaterThan(0);
		expect(listenerCount(h.metadataCache)).toBeGreaterThan(0);
		expect(listenerCount(h.vault)).toBeGreaterThan(0);

		h.plugin.unload();

		expect(backends[0]?.killAll).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalled();
		expect(listenerCount(h.workspace)).toBe(0);
		expect(listenerCount(h.metadataCache)).toBe(0);
		expect(listenerCount(h.vault)).toBe(0);
		expect(added.mock.calls.length).toBeGreaterThan(0);
		expect(removed.mock.calls.map((call) => call[0])).toEqual(added.mock.calls.map((call) => call[0]));
	});
});
