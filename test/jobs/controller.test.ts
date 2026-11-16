import { describe, expect, it } from "vitest";
import { MenardError } from "../../src/errors";
import { JobController } from "../../src/jobs/controller";
import { createHarness } from "./harness";
import { LAYOUT_B, SOURCE_NOTE } from "./fixtures";

describe("JobController", () => {
	it("runs one job at a time and cancels the running one", async () => {
		const h = createHarness();
		const jobs = new JobController(h.deps);
		const source = h.vault.add("T/@x.md", SOURCE_NOTE);
		let release: () => void = () => undefined;
		h.backend.handler = async (request) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			request.signal.throwIfAborted();
			return { headings: ["EN El laberinto como forma"] };
		};
		expect(jobs.cancel()).toBe(false);
		const first = jobs.translate(source);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(jobs.isRunning()).toBe(true);
		expect(jobs.canTranslate(source)).toBe(false);
		await jobs.translate(source);
		expect(h.ui.notices).toEqual(["Another Menard job is running. Cancel it or wait for it to finish."]);
		expect(jobs.cancel()).toBe(true);
		release();
		await first;
		expect(jobs.isRunning()).toBe(false);
		expect(jobs.canTranslate(source)).toBe(true);
	});

	it("turns job errors into notices", async () => {
		const h = createHarness();
		const jobs = new JobController(h.deps);
		h.backend.handler = () => {
			throw new MenardError("cli-not-logged-in", "Not logged in");
		};
		await jobs.translate(h.vault.add("T/@x.md", SOURCE_NOTE));
		expect(h.ui.notices).toEqual([
			"Claude Code is not signed in for apps started outside a terminal. Run `claude` once in a terminal and sign in, then try again.",
		]);
		expect(jobs.isRunning()).toBe(false);
	});

	it("offers split only on notes with the boundary heading, and never on translation notes", async () => {
		const h = createHarness();
		const jobs = new JobController(h.deps);
		const combined = h.vault.add("T/@giordano.md", LAYOUT_B);
		expect(jobs.canSplit(combined, LAYOUT_B)).toBe(true);
		expect(jobs.canSplit(combined, "# Text\n\nSolo castellano.\n")).toBe(false);
		await jobs.translate(h.vault.add("T/@x.md", SOURCE_NOTE));
		const translation = h.vault.getFileByPath("T/@x (EN).md");
		if (translation === null) throw new Error("no translation");
		expect(jobs.canTranslate(translation)).toBe(false);
		expect(jobs.canAlign(translation)).toBe(false);
	});

	it("checks the Claude Code connection and reports path, model and latency", async () => {
		const h = createHarness();
		const jobs = new JobController(h.deps);
		await jobs.checkClaude();
		expect(h.ui.notices).toEqual(["Claude Code works: /Users/test/.local/bin/claude, model sonnet, answered in 1.2 s."]);

		h.deps.detect = async () => ({ path: null, via: null, tried: ["/a/claude", "/b/claude"] });
		await jobs.checkClaude();
		expect(h.ui.notices.at(-1)).toBe("Claude Code was not found. Set its path in Menard's options. Looked in: /a/claude, /b/claude.");
	});
});
