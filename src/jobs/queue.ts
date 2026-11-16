/**
 * Runs tasks with bounded concurrency, cancellation and per-task failure
 * isolation. Owner: jobs module. DESIGN.md §7.4.
 */
import { isMenardError } from "../errors";
import type { MenardErrorCode } from "../errors";

export interface Task {
	/** Unit key or other stable id. */
	key: string;
	run(signal: AbortSignal): Promise<void>;
}

export interface JobReport {
	done: number;
	failed: { key: string; reason: string }[];
	cancelled: boolean;
	/** Set when a job-fatal error (auth, not found, rate limit) stopped the queue. */
	stoppedBy?: string;
}

export interface QueueEvents {
	onProgress(done: number, failed: number, running: number, total: number): void;
}

/** Errors after which no other task can succeed either. */
export const JOB_FATAL_CODES: ReadonlySet<MenardErrorCode> = new Set<MenardErrorCode>([
	"cli-not-found",
	"cli-not-logged-in",
	"cli-rate-limited",
	"desktop-only",
	"not-owned",
	"insert-only-violation",
]);

export class JobQueue {
	constructor(private readonly concurrency: number) {}

	/**
	 * Runs every task; a task that throws MenardError with a job-fatal code
	 * (cli-not-found, cli-not-logged-in, cli-rate-limited, desktop-only, or
	 * a write-safety violation) aborts the rest. Other failures are recorded
	 * and the queue continues. A task that settles after the abort still
	 * counts if it succeeded; one that fails because of the abort is
	 * discarded, neither done nor failed.
	 */
	async run(tasks: readonly Task[], controller: AbortController, events: QueueEvents): Promise<JobReport> {
		const { signal } = controller;
		const report: JobReport = { done: 0, failed: [], cancelled: false };
		let next = 0;
		let running = 0;
		const progress = (): void => events.onProgress(report.done, report.failed.length, running, tasks.length);

		const worker = async (): Promise<void> => {
			for (let task = tasks[next]; task !== undefined && !signal.aborted; task = tasks[next]) {
				next++;
				running++;
				progress();
				try {
					await task.run(signal);
					report.done++;
				} catch (error) {
					if (isMenardError(error) && JOB_FATAL_CODES.has(error.code)) {
						report.stoppedBy ??= error.code;
						controller.abort();
					} else if (!signal.aborted) {
						report.failed.push({ key: task.key, reason: error instanceof Error ? error.message : String(error) });
					}
				} finally {
					running--;
					progress();
				}
			}
		};

		const workers = Math.max(1, Math.min(Math.floor(this.concurrency), tasks.length));
		await Promise.all(Array.from({ length: workers }, worker));
		report.cancelled = signal.aborted && report.stoppedBy === undefined;
		return report;
	}
}
