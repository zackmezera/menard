// @vitest-environment happy-dom
import "./dom-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { MenardError } from "../../src/errors";
import { ProgressNotice, messageFor, progressText } from "../../src/jobs/progress";

/** The test double's view of a Notice: what it was constructed or last set with. */
interface ShownNotice {
	message: string | DocumentFragment;
	duration?: number;
}

function noticeOf(progress: ProgressNotice): ShownNotice {
	const notice: unknown = Reflect.get(progress, "notice");
	if (!(notice instanceof Notice)) throw new Error("no notice shown");
	return notice as unknown as ShownNotice;
}

function fragmentText(notice: ShownNotice): string {
	const message = notice.message;
	return typeof message === "string" ? message : (message.textContent ?? "");
}

describe("ProgressNotice", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a persistent notice with Cancel, mirrored in the status bar, at most four times a second", () => {
		const statusBar = document.createElement("div");
		const onCancel = vi.fn();
		const progress = new ProgressNotice("Translating @ruizalmotasim", onCancel, statusBar);
		progress.update(0, 0, 1, 74);
		const notice = noticeOf(progress);
		expect(notice.duration).toBe(0);
		expect(fragmentText(notice)).toBe("Translating @ruizalmotasim: 0 of 74 · 1 runningCancel");
		expect(statusBar.textContent).toBe("Translating @ruizalmotasim: 0 of 74 · 1 running");

		progress.update(1, 0, 2, 74);
		progress.update(23, 1, 2, 74);
		expect(statusBar.textContent).toBe("Translating @ruizalmotasim: 0 of 74 · 1 running");
		vi.advanceTimersByTime(250);
		expect(statusBar.textContent).toBe("Translating @ruizalmotasim: 23 of 74 · 2 running · 1 failed");

		const message = noticeOf(progress).message as DocumentFragment;
		message.querySelector("button")?.dispatchEvent(new Event("click"));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("closes without a summary, and ignores what comes after", () => {
		const statusBar = document.createElement("div");
		const progress = new ProgressNotice("Translating @x", () => undefined, statusBar);
		progress.update(1, 0, 1, 2);
		const hide = vi.spyOn(noticeOf(progress) as unknown as Notice, "hide");
		progress.close();
		expect(hide).toHaveBeenCalledOnce();
		expect(statusBar.textContent).toBe("");
		progress.update(2, 0, 0, 2);
		progress.finish("Translating cancelled: 1 of 2 written.");
		vi.advanceTimersByTime(1000);
		expect(Reflect.get(progress, "notice")).toBeNull();
		expect(statusBar.textContent).toBe("");
	});

	it("finishes with a summary and an optional action, clearing the status bar", () => {
		const statusBar = document.createElement("div");
		const progress = new ProgressNotice("Translating @x", () => undefined, statusBar);
		progress.update(1, 0, 1, 2);
		progress.update(2, 0, 0, 2);
		const open = vi.fn();
		progress.finish("Translated 2 of 2.", { label: "Open facing view", run: open });
		vi.advanceTimersByTime(1000);
		expect(fragmentText(noticeOf(progress))).toBe("Translated 2 of 2.Open facing view");
		expect(statusBar.textContent).toBe("");
		(noticeOf(progress).message as DocumentFragment).querySelector("button")?.dispatchEvent(new Event("click"));
		expect(open).toHaveBeenCalledOnce();
	});
});

describe("progressText and messageFor", () => {
	it("omits zero counts", () => {
		expect(progressText("Aligning @x", 3, 0, 0, 9)).toBe("Aligning @x: 3 of 9");
	});

	it("uses the DESIGN §11 copy", () => {
		expect(messageFor(new MenardError("cli-not-found", "spawn ENOENT"))).toBe("Claude Code was not found. Set its path in Menard's options.");
		expect(messageFor(new MenardError("desktop-only", ""))).toBe("Translation needs the desktop app.");
		expect(messageFor(new MenardError("write-conflict", ""))).toBe("The note changed while writing; run again.");
		expect(messageFor(new MenardError("pair-not-reciprocal", ""))).toBe(
			"This note links to a translation that does not link back. Run Check alignment to repair.",
		);
		expect(messageFor(new MenardError("output-invalid", "Claude's answer was rejected: x."))).toBe("Claude's answer was rejected: x.");
		expect(messageFor(new Error("plain"))).toBe("plain");
	});
});
