// @vitest-environment happy-dom
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MenardErrorCode } from "../../src/errors";
import { isMenardError } from "../../src/errors";
import { buildArgs, childEnv, ClaudeCliBackend, KILL_GRACE_MS } from "../../src/llm/claude-cli";
import type { BackendRequest } from "../../src/types";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const PROMPT = '{"sentences": [{"n": 1, "text": "Según el Sr. Pérez, Borges leyó a Poe en Ginebra.⟦^1⟧"}]}';

describe("buildArgs", () => {
	const args = buildArgs({ system: "Translate «this».", schema: SCHEMA, model: "sonnet" });

	it("builds the documented argv", () => {
		expect(args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--model",
			"sonnet",
			"--safe-mode",
			"--strict-mcp-config",
			"--tools",
			"",
			"--no-session-persistence",
			"--max-turns",
			"3",
			"--system-prompt",
			"Translate «this».",
			"--json-schema",
			JSON.stringify(SCHEMA),
		]);
	});

	it("contains --safe-mode and never --bare or --setting-sources", () => {
		expect(args).toContain("--safe-mode");
		expect(args).not.toContain("--bare");
		expect(args).not.toContain("--setting-sources");
	});
});

describe("childEnv", () => {
	const user = { homedir: "/Users/ana", username: "ana" };

	it("fills HOME and USER when missing or empty", () => {
		expect(childEnv({ PATH: "/usr/bin", USER: "", NOTHING: undefined }, user)).toEqual({ PATH: "/usr/bin", HOME: "/Users/ana", USER: "ana" });
	});

	it("keeps values already set", () => {
		expect(childEnv({ HOME: "/home/x", USER: "x" }, user)).toEqual({ HOME: "/home/x", USER: "x" });
	});

	it("does not invent an empty USER", () => {
		expect(childEnv({}, { homedir: "/Users/ana", username: "" })).toEqual({ HOME: "/Users/ana" });
	});

	it("puts the executable's folder first on PATH, once, keeping the variable's spelling", () => {
		const env = { HOME: "/h", USER: "u" };
		expect(childEnv({ ...env, PATH: "/usr/bin:/opt/homebrew/bin" }, user, "/opt/homebrew/bin").PATH).toBe("/opt/homebrew/bin:/usr/bin");
		expect(childEnv(env, user, "/opt/homebrew/bin").PATH).toBe("/opt/homebrew/bin");
		const windows = childEnv({ ...env, Path: "C:\\Windows" }, user, "C:\\Users\\ana\\bin", ";");
		expect(windows.Path).toBe("C:\\Users\\ana\\bin;C:\\Windows");
		expect(windows.PATH).toBeUndefined();
	});
});

/**
 * A stand-in for `claude`, driven by environment variables:
 * FAKE_CLAUDE_MODE = envelope | crash | sleep | ignore-term | flood | orphan;
 * FAKE_CLAUDE_ENVELOPE = what `envelope` prints;
 * FAKE_CLAUDE_DUMP = file that receives argv, stdin, cwd and HOME/USER.
 */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("fs");
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === "ignore-term") process.on("SIGTERM", () => {});
if (mode === "orphan") {
	// A grandchild that keeps stdout open for a while after its parent dies.
	require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: ["ignore", "inherit", "inherit"] });
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
	if (process.env.FAKE_CLAUDE_DUMP) {
		const dump = { argv: process.argv.slice(2), stdin, cwd: process.cwd(), home: process.env.HOME, user: process.env.USER };
		fs.writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify(dump));
	}
	if (mode === "envelope") process.stdout.write(process.env.FAKE_CLAUDE_ENVELOPE);
	else if (mode === "crash") {
		process.stderr.write("Error: something broke\\n");
		process.exit(1);
	} else if (mode === "flood") process.stdout.write("x".repeat(5 * 1024 * 1024));
	else setInterval(() => {}, 1000);
});
`;

describe("ClaudeCliBackend", () => {
	let dir: string;
	let fake: string;
	let dumpFile: string;
	const savedEnv = { ...process.env };

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "menard-cli-test-"));
		fake = join(dir, "claude");
		writeFileSync(fake, FAKE_CLAUDE);
		chmodSync(fake, 0o755);
		dumpFile = join(dir, "dump.json");
	});

	afterEach(() => {
		process.env = { ...savedEnv };
		Platform.isDesktop = true;
		rmSync(dumpFile, { force: true });
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function setFake(mode: string, envelope?: object): void {
		process.env.FAKE_CLAUDE_MODE = mode;
		process.env.FAKE_CLAUDE_DUMP = dumpFile;
		if (envelope) process.env.FAKE_CLAUDE_ENVELOPE = JSON.stringify(envelope);
	}

	function request(extra: Partial<BackendRequest> = {}): BackendRequest {
		return { system: "You answer connection checks.", prompt: PROMPT, schema: SCHEMA, model: "sonnet", timeoutMs: 10_000, signal: new AbortController().signal, ...extra };
	}

	function readDump(): { argv: string[]; stdin: string; cwd: string; home: string; user: string } {
		return JSON.parse(readFileSync(dumpFile, "utf8")) as ReturnType<typeof readDump>;
	}

	async function codeOf(promise: Promise<unknown>): Promise<MenardErrorCode | "resolved" | "other error"> {
		try {
			await promise;
			return "resolved";
		} catch (error) {
			return isMenardError(error) ? error.code : "other error";
		}
	}

	it("sends the prompt on stdin, the argv, and returns the structured output", async () => {
		setFake("envelope", { type: "result", subtype: "success", is_error: false, result: "", structured_output: { ok: true } });
		const backend = new ClaudeCliBackend(() => Promise.resolve(fake));
		const result = await backend.run(request());
		expect(result.output).toEqual({ ok: true });
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		const dump = readDump();
		expect(dump.stdin).toBe(PROMPT);
		expect(dump.argv).toEqual(buildArgs(request()));
	});

	it("runs in a fresh temp directory that is removed afterwards", async () => {
		setFake("envelope", { is_error: false, structured_output: { ok: true } });
		const backend = new ClaudeCliBackend(() => Promise.resolve(fake));
		await backend.run(request());
		const first = readDump().cwd;
		await backend.run(request());
		const second = readDump().cwd;

		expect(first.startsWith(join(realpathSync(tmpdir()), "menard-"))).toBe(true);
		expect(second).not.toBe(first);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
	});

	it("fills HOME and USER for the child when the environment lacks them", async () => {
		setFake("envelope", { is_error: false, structured_output: { ok: true } });
		delete process.env.HOME;
		delete process.env.USER;
		await new ClaudeCliBackend(() => Promise.resolve(fake)).run(request());
		const dump = readDump();
		expect(dump.home).toBeTruthy();
		expect(dump.user).toBeTruthy();
	});

	it("maps an error envelope through parseEnvelope", async () => {
		setFake("envelope", { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request()))).toBe("cli-not-logged-in");
	});

	it("reports a non-zero exit without JSON as a crash", async () => {
		setFake("crash");
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request()))).toBe("cli-crash");
	});

	it("reports a missing or non-executable path as cli-not-found", async () => {
		setFake("envelope", { is_error: false, structured_output: { ok: true } });
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(join(dir, "nowhere"))).run(request()))).toBe("cli-not-found");
		const plain = join(dir, "plain");
		writeFileSync(plain, FAKE_CLAUDE);
		chmodSync(plain, 0o644);
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(plain)).run(request()))).toBe("cli-not-found");
	});

	it("starts a `#!/usr/bin/env node` script whose node sits next to it under a bare GUI PATH", async () => {
		const npmBin = join(dir, "npm-bin");
		mkdirSync(npmBin);
		symlinkSync(process.execPath, join(npmBin, "node"));
		const script = join(npmBin, "claude");
		writeFileSync(script, FAKE_CLAUDE.replace(/^#!.*$/m, "#!/usr/bin/env node"));
		chmodSync(script, 0o755);
		setFake("envelope", { is_error: false, structured_output: { ok: true } });
		process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
		expect((await new ClaudeCliBackend(() => Promise.resolve(script)).run(request())).output).toEqual({ ok: true });
	});

	it("tells its owner when the resolved path cannot be started, so it is looked up again", async () => {
		let missing = 0;
		const backend = new ClaudeCliBackend(
			() => Promise.resolve(join(dir, "removed")),
			() => missing++,
		);
		expect(await codeOf(backend.run(request()))).toBe("cli-not-found");
		expect(missing).toBe(1);
	});

	it("passes on the resolver's own error", async () => {
		const backend = new ClaudeCliBackend(() => Promise.reject(new Error("no claude")));
		await expect(backend.run(request())).rejects.toThrow("no claude");
	});

	it("times out with SIGTERM and removes the temp directory", async () => {
		setFake("sleep");
		const started = Date.now();
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request({ timeoutMs: 400 })))).toBe("cli-timeout");
		expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS);
		expect(existsSync(readDump().cwd)).toBe(false);
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		setFake("ignore-term");
		const started = Date.now();
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request({ timeoutMs: 300 })))).toBe("cli-timeout");
		expect(Date.now() - started).toBeGreaterThanOrEqual(300 + KILL_GRACE_MS - 50);
	}, 15_000);

	it("cancels on abort", async () => {
		setFake("sleep");
		const controller = new AbortController();
		const run = new ClaudeCliBackend(() => Promise.resolve(fake)).run(request({ signal: controller.signal }));
		window.setTimeout(() => controller.abort(), 300);
		expect(await codeOf(run)).toBe("cancelled");
		expect(existsSync(readDump().cwd)).toBe(false);
	});

	it("settles a stopped run without waiting for a grandchild that holds stdout open", async () => {
		setFake("orphan");
		const started = Date.now();
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request({ timeoutMs: 300 })))).toBe("cli-timeout");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("does not spawn when the signal fires while the path is being resolved", async () => {
		setFake("sleep");
		const controller = new AbortController();
		const resolvePath = (): Promise<string> => {
			controller.abort();
			return Promise.resolve(fake);
		};
		const started = Date.now();
		expect(await codeOf(new ClaudeCliBackend(resolvePath).run(request({ signal: controller.signal })))).toBe("cancelled");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(existsSync(dumpFile)).toBe(false);
	});

	it("does not spawn when the signal is already aborted", async () => {
		setFake("envelope", { is_error: false, structured_output: { ok: true } });
		const controller = new AbortController();
		controller.abort();
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request({ signal: controller.signal })))).toBe("cancelled");
		expect(existsSync(dumpFile)).toBe(false);
	});

	it("kills every live child with killAll", async () => {
		setFake("sleep");
		const backend = new ClaudeCliBackend(() => Promise.resolve(fake));
		const runs = [backend.run(request()), backend.run(request())];
		await new Promise((resolve) => window.setTimeout(resolve, 400));
		backend.killAll();
		expect(await Promise.all(runs.map(codeOf))).toEqual(["cancelled", "cancelled"]);
	});

	it("stops a child whose output exceeds the cap", async () => {
		setFake("flood");
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request()))).toBe("cli-bad-envelope");
	});

	it("refuses to run outside the desktop app", async () => {
		Platform.isDesktop = false;
		expect(await codeOf(new ClaudeCliBackend(() => Promise.resolve(fake)).run(request()))).toBe("desktop-only");
	});
});
