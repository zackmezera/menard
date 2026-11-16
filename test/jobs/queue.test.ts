import { describe, expect, it } from "vitest";
import { MenardError } from "../../src/errors";
import { JobQueue } from "../../src/jobs/queue";
import type { Task } from "../../src/jobs/queue";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A task that waits, then succeeds or throws; it rejects as the CLI does when aborted while waiting. */
function task(key: string, ms: number, outcome: Error | null = null, log?: string[]): Task {
	return {
		key,
		run: async (signal) => {
			log?.push(`start ${key}`);
			await sleep(ms);
			if (signal.aborted) throw new MenardError("cancelled", "Cancelled.");
			if (outcome !== null) throw outcome;
			log?.push(`done ${key}`);
		},
	};
}

describe("JobQueue", () => {
	it("never runs more tasks at once than its concurrency", async () => {
		let running = 0;
		let peak = 0;
		const tasks: Task[] = Array.from({ length: 7 }, (_, i) => ({
			key: `p${i}`,
			run: async () => {
				running++;
				peak = Math.max(peak, running);
				await sleep(5);
				running--;
			},
		}));
		const report = await new JobQueue(3).run(tasks, new AbortController(), { onProgress: () => undefined });
		expect(peak).toBe(3);
		expect(report).toEqual({ done: 7, failed: [], cancelled: false });
	});

	it("records ordinary failures and keeps going", async () => {
		const report = await new JobQueue(2).run(
			[task("p1", 1), task("p2", 1, new MenardError("output-invalid", "bad answer")), task("p3", 1, new Error("boom")), task("p4", 1)],
			new AbortController(),
			{ onProgress: () => undefined },
		);
		expect(report).toEqual({ done: 2, failed: [{ key: "p2", reason: "bad answer" }, { key: "p3", reason: "boom" }], cancelled: false });
	});

	it("stops everything on a job-fatal error and names it", async () => {
		const log: string[] = [];
		const controller = new AbortController();
		const report = await new JobQueue(2).run(
			[task("p1", 2, null, log), task("p2", 1, new MenardError("cli-not-logged-in", "Not logged in"), log), task("p3", 1, null, log), task("p4", 1, null, log)],
			controller,
			{ onProgress: () => undefined },
		);
		expect(controller.signal.aborted).toBe(true);
		expect(report.stoppedBy).toBe("cli-not-logged-in");
		expect(report.cancelled).toBe(false);
		expect(report.failed).toEqual([]);
		expect(log).toEqual(["start p1", "start p2"]);
	});

	it("discards tasks in flight when aborted, but counts one that finished its work", async () => {
		const controller = new AbortController();
		const finishesAnyway: Task = {
			key: "p2",
			run: async () => {
				await sleep(10);
			},
		};
		setTimeout(() => controller.abort(), 3);
		const report = await new JobQueue(2).run([task("p1", 10), finishesAnyway, task("p3", 1)], controller, { onProgress: () => undefined });
		expect(report).toEqual({ done: 1, failed: [], cancelled: true });
	});

	it("reports progress after every change", async () => {
		const events: number[][] = [];
		await new JobQueue(1).run([task("p1", 1), task("p2", 1, new Error("x"))], new AbortController(), {
			onProgress: (...args) => events.push(args),
		});
		expect(events).toEqual([
			[0, 0, 1, 2],
			[1, 0, 0, 2],
			[1, 0, 1, 2],
			[1, 1, 0, 2],
		]);
	});

	it("finishes at once with nothing to do", async () => {
		expect(await new JobQueue(2).run([], new AbortController(), { onProgress: () => undefined })).toEqual({ done: 0, failed: [], cancelled: false });
	});
});
