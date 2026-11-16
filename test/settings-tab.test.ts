import { Plugin } from "obsidian";
import type { App, PluginManifest, SettingDefinitionItem } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectClaude } from "../src/llm/detect";
import { DEFAULT_SETTINGS } from "../src/settings";
import { MenardSettingTab } from "../src/settings-tab";
import type { SettingsHost } from "../src/settings-tab";
import type { MenardSettings } from "../src/types";

vi.mock("../src/llm/detect", () => ({ detectClaude: vi.fn() }));

const GROUPS = ["Translation backend", "Languages", "Notes", "Reading", "Editing", "Safety"];
/** Proper nouns allowed to keep their capital inside a sentence-case name. */
const PROPER = new Set(["Claude", "Code", "Anthropic"]);

class Host extends Plugin implements SettingsHost {
	override settings: MenardSettings = { ...DEFAULT_SETTINGS };
	readonly saveSettings = vi.fn(async () => {});
	readonly checkClaude = vi.fn(async () => {});
}

type Group = Extract<SettingDefinitionItem, { type: "group" | "list" }>;
type Entry = { name: string; desc?: unknown; control?: { key: string }; action?: (el: HTMLElement, index: number) => void };

function setup(): { tab: MenardSettingTab; host: Host; groups: Group[]; entries: Entry[] } {
	const host = new Host({} as App, {} as PluginManifest);
	const tab = new MenardSettingTab({} as App, host);
	const groups = tab.getSettingDefinitions() as Group[];
	const entries = groups.flatMap((group) => (group.items ?? []) as Entry[]);
	return { tab, host, groups, entries };
}

function isSentenceCase(text: string): boolean {
	const words = text.split(/\s+/);
	if (!/^[A-Z]/.test(words[0] ?? "")) return false;
	return words.slice(1).every((word) => !/^[A-Z]/.test(word) || PROPER.has(word));
}

beforeEach(() => vi.mocked(detectClaude).mockReset());

describe("MenardSettingTab definitions", () => {
	it("has the six groups of DESIGN §12.1 in order, with no 'settings' in their headings", () => {
		const { groups } = setup();
		expect(groups.map((group) => group.type)).toEqual(GROUPS.map(() => "group"));
		expect(groups.map((group) => group.heading)).toEqual(GROUPS);
		for (const group of groups) expect(group.heading?.toLowerCase()).not.toContain("settings");
	});

	it("binds every settings key exactly once", () => {
		const { entries } = setup();
		const keys = entries.flatMap((entry) => (entry.control ? [entry.control.key] : []));
		expect([...keys].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("uses sentence case for every name and gives every entry a description", () => {
		const { groups, entries } = setup();
		for (const group of groups) expect(isSentenceCase(group.heading ?? "")).toBe(true);
		for (const entry of entries) {
			expect(isSentenceCase(entry.name), entry.name).toBe(true);
			expect(typeof entry.desc === "string" && entry.desc.endsWith("."), entry.name).toBe(true);
		}
	});

	it("discloses the use of the claude CLI in the translation backend group", () => {
		const { groups } = setup();
		const text = ((groups[0]?.items ?? []) as Entry[]).map((entry) => (typeof entry.desc === "string" ? entry.desc : "")).join(" ");
		expect(text).toMatch(/Anthropic/);
		expect(text).toMatch(/Claude account/);
		expect(text).toMatch(/telemetry/);
	});
});

describe("MenardSettingTab actions", () => {
	it("writes a changed value to the plugin settings and saves through the plugin", async () => {
		const { tab, host } = setup();
		await tab.setControlValue("concurrency", 4);
		expect(host.settings.concurrency).toBe(4);
		expect(host.saveSettings).toHaveBeenCalledTimes(1);
	});

	it("Detect probes the login shell and fills the path", async () => {
		vi.mocked(detectClaude).mockResolvedValue({ path: "/home/u/.local/bin/claude", via: "shell", tried: [] });
		const { host, entries } = setup();
		entries.find((entry) => entry.name === "Detect")?.action?.({} as HTMLElement, 0);
		await vi.waitFor(() => expect(host.saveSettings).toHaveBeenCalled());
		expect(detectClaude).toHaveBeenCalledWith("", { probeShell: true });
		expect(host.settings.claudePath).toBe("/home/u/.local/bin/claude");
	});

	it("Detect leaves the path alone when nothing is found", async () => {
		vi.mocked(detectClaude).mockResolvedValue({ path: null, via: null, tried: ["/a"] });
		const { host, entries } = setup();
		entries.find((entry) => entry.name === "Detect")?.action?.({} as HTMLElement, 0);
		await vi.waitFor(() => expect(detectClaude).toHaveBeenCalled());
		await Promise.resolve();
		expect(host.settings.claudePath).toBe("");
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it("Test connection runs the plugin's connection check", () => {
		const { host, entries } = setup();
		entries.find((entry) => entry.name === "Test connection")?.action?.({} as HTMLElement, 0);
		expect(host.checkClaude).toHaveBeenCalledTimes(1);
	});

	it("validates language codes, absolute paths and number ranges", () => {
		const { entries } = setup();
		const validate = (key: keyof MenardSettings, value: unknown): unknown => {
			const control = entries.find((entry) => entry.control?.key === key)?.control as { validate?: (v: unknown) => unknown } | undefined;
			return control?.validate?.(value);
		};
		expect(validate("defaultSourceLanguage", "pt-BR")).toBeUndefined();
		expect(validate("defaultSourceLanguage", "not a tag!")).toEqual(expect.any(String));
		expect(validate("claudePath", "")).toBeUndefined();
		expect(validate("claudePath", "~/.local/bin/claude")).toBeUndefined();
		expect(validate("claudePath", "bin/claude")).toEqual(expect.any(String));
		expect(validate("backupCount", 0)).toEqual(expect.any(String));
		expect(validate("timeoutSeconds", 180)).toBeUndefined();
	});
});
