/**
 * The v1 backend: runs `claude -p` as a child process (ADR 0004).
 * The only module that spawns processes. Owner: llm module. DESIGN.md §10.2.
 */
import type { ChildProcess } from "child_process";
import { Platform } from "obsidian";
import { MenardError, isMenardError } from "../errors";
import type { BackendRequest, BackendResult, TranslationBackend } from "../types";
import { parseEnvelope } from "./envelope";

/** Grace period between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3000;
export const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
export const STDERR_CAP_BYTES = 64 * 1024;

/** argv for one call (never `--bare`); the prompt goes on stdin. Pure. */
export function buildArgs(request: Pick<BackendRequest, "system" | "schema" | "model">): string[] {
	return [
		"-p",
		"--output-format",
		"json",
		"--model",
		request.model,
		"--safe-mode",
		"--strict-mcp-config",
		"--tools",
		"",
		"--no-session-persistence",
		"--max-turns",
		"3",
		"--system-prompt",
		request.system,
		"--json-schema",
		JSON.stringify(request.schema),
	];
}

/**
 * Environment for the child: process.env plus HOME and USER when missing,
 * and the executable's own folder first on PATH. An app started from the
 * Dock or Finder gets a bare PATH, and an npm-installed `claude` is a
 * `#!/usr/bin/env node` script whose `node` sits next to it. Pure.
 */
export function childEnv(
	env: Readonly<Record<string, string | undefined>>,
	user: { homedir: string; username: string },
	executableDir = "",
	delimiter = ":",
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) result[key] = value;
	}
	if (!result.HOME && user.homedir) result.HOME = user.homedir;
	if (!result.USER && user.username) result.USER = user.username;
	if (executableDir !== "") {
		// Windows spells it "Path"; whichever spelling the environment uses is kept.
		const pathKey = Object.keys(result).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
		const entries = (result[pathKey] ?? "").split(delimiter).filter((entry) => entry !== "" && entry !== executableDir);
		result[pathKey] = [executableDir, ...entries].join(delimiter);
	}
	return result;
}

type StopReason = "timeout" | "cancelled" | "overflow";

interface Running {
	child: ChildProcess;
	stop(reason: StopReason): void;
}

interface Exit {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export class ClaudeCliBackend implements TranslationBackend {
	readonly name = "claude-cli";
	private readonly running = new Set<Running>();

	/**
	 * `resolvePath` returns the executable's absolute path or throws
	 * cli-not-found; `onMissing` runs when that path could not be started,
	 * so a remembered path is looked up again.
	 */
	constructor(
		private readonly resolvePath: () => Promise<string>,
		private readonly onMissing: () => void = () => undefined,
	) {}

	/**
	 * Spawns in a fresh temp cwd, writes the prompt to stdin, enforces the
	 * timeout (SIGTERM, then SIGKILL after 3 s), honours the abort signal,
	 * caps output, and parses the envelope.
	 */
	async run(request: BackendRequest): Promise<BackendResult> {
		const { fs, os, path } = nodeModules();
		if (request.signal.aborted) throw cancelled();
		const executable = await this.resolvePath();
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "menard-"));
		try {
			const started = Date.now();
			const exit = await this.spawn(executable, cwd, request);
			return { output: parseEnvelope(exit.stdout, exit.exitCode, exit.stderr), durationMs: Date.now() - started };
		} catch (error) {
			if (isMenardError(error, "cli-not-found")) this.onMissing();
			throw error;
		} finally {
			// A leftover empty temp dir must not replace the call's own result or error.
			await fs.promises.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Kills every live child; registered with the plugin's lifetime. */
	killAll(): void {
		for (const running of this.running) running.stop("cancelled");
	}

	private spawn(executable: string, cwd: string, request: BackendRequest): Promise<Exit> {
		const { cp, os, path } = nodeModules();
		return new Promise<Exit>((resolve, reject) => {
			// The signal may have fired while the path was resolved; an abort listener added now would never run.
			if (request.signal.aborted) {
				reject(cancelled());
				return;
			}
			let child: ChildProcess;
			try {
				child = cp.spawn(executable, buildArgs(request), {
					cwd,
					env: childEnv(process.env, currentUser(os), path.dirname(executable), path.delimiter),
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				reject(spawnError(error, executable));
				return;
			}

			const stdout = new CappedBuffer(STDOUT_CAP_BYTES);
			const stderr = new CappedBuffer(STDERR_CAP_BYTES);
			let reason: StopReason | null = null;
			let killTimer: number | undefined;
			let settled = false;

			const running: Running = {
				child,
				stop: (why) => {
					if (reason !== null || child.exitCode !== null || child.signalCode !== null) return;
					reason = why;
					child.kill("SIGTERM");
					killTimer = window.setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					}, KILL_GRACE_MS);
				},
			};
			const onAbort = (): void => running.stop("cancelled");
			const timeoutTimer = window.setTimeout(() => running.stop("timeout"), request.timeoutMs);

			const finish = (outcome: () => void): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeoutTimer);
				window.clearTimeout(killTimer);
				request.signal.removeEventListener("abort", onAbort);
				this.running.delete(running);
				outcome();
			};

			this.running.add(running);
			request.signal.addEventListener("abort", onAbort, { once: true });

			child.stdout?.on("data", (chunk: Buffer) => {
				if (!stdout.push(chunk)) running.stop("overflow");
			});
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			// A child that exits before reading its prompt closes the pipe (EPIPE); its exit says what happened.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(request.prompt, "utf8");

			const stopped = (why: StopReason): MenardError => {
				if (why === "timeout") return new MenardError("cli-timeout", `Claude Code did not answer within ${Math.round(request.timeoutMs / 1000)} s.`);
				if (why === "overflow") return new MenardError("cli-bad-envelope", "Claude Code's output exceeded 4 MB.");
				return cancelled();
			};

			child.on("error", (error) => finish(() => reject(spawnError(error, executable))));
			// A stopped child settles on exit: a grandchild holding its stdout open would otherwise delay "close".
			child.on("exit", () => {
				if (reason !== null) {
					const why = reason;
					finish(() => reject(stopped(why)));
				}
			});
			child.on("close", (code) =>
				finish(() => {
					if (reason !== null) reject(stopped(reason));
					else resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code });
				}),
			);
		});
	}
}

/** Collects stream chunks up to a byte cap; `push` returns false once the cap is exceeded. */
class CappedBuffer {
	private readonly chunks: Buffer[] = [];
	private size = 0;

	constructor(private readonly cap: number) {}

	push(chunk: Buffer): boolean {
		const room = this.cap - this.size;
		if (room > 0) {
			const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
			this.chunks.push(kept);
			this.size += kept.length;
		}
		return chunk.length <= room;
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

function cancelled(): MenardError {
	return new MenardError("cancelled", "Cancelled.");
}

function spawnError(error: unknown, executable: string): MenardError {
	if (isMenardError(error)) return error;
	const code = (error as NodeJS.ErrnoException | null)?.code;
	if (code === "ENOENT" || code === "EACCES") {
		return new MenardError("cli-not-found", `Claude Code could not be started from ${executable}.`, error);
	}
	return new MenardError("cli-crash", `Claude Code could not be started: ${error instanceof Error ? error.message : String(error)}`, error);
}

function currentUser(os: typeof import("os")): { homedir: string; username: string } {
	let username = "";
	try {
		username = os.userInfo().username;
	} catch {
		// No passwd entry for this uid; USER stays as the environment has it.
	}
	return { homedir: os.homedir(), username };
}

function nodeModules(): {
	cp: typeof import("child_process");
	fs: typeof import("fs");
	os: typeof import("os");
	path: typeof import("path");
} {
	if (!Platform.isDesktop) {
		throw new MenardError("desktop-only", "Translation needs the desktop app.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- Node built-ins load lazily, after the Platform.isDesktop guard (DESIGN.md §3.1). */
	return {
		cp: require("child_process") as typeof import("child_process"),
		fs: require("fs") as typeof import("fs"),
		os: require("os") as typeof import("os"),
		path: require("path") as typeof import("path"),
	};
	/* eslint-enable @typescript-eslint/no-require-imports -- end of the guarded block. */
}
