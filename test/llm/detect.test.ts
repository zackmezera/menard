import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isMenardError } from "../../src/errors";
import { candidatePaths, detectClaude } from "../../src/llm/detect";

describe("candidatePaths", () => {
	it("lists the usual install locations in order", () => {
		expect(candidatePaths("/Users/ana", "darwin")).toEqual([
			"/Users/ana/.local/bin/claude",
			"/Users/ana/.claude/local/claude",
			"/opt/homebrew/bin/claude",
			"/usr/local/bin/claude",
		]);
	});

	it("adds the native Windows binary on win32, but not npm's claude.cmd, which cannot be spawned without a shell", () => {
		const paths = candidatePaths("C:\\Users\\ana", "win32");
		expect(paths.at(-1)).toBe("C:\\Users\\ana\\.local\\bin\\claude.exe");
		expect(paths.some((path) => path.endsWith(".cmd"))).toBe(false);
	});
});

describe("detectClaude", () => {
	let dir: string;
	let executable: string;
	let plainFile: string;
	let folder: string;
	let missing: string;
	const shell = process.env.SHELL;

	/** A fake login shell that prints `path` for `command -v claude`. */
	function fakeShell(output: string): string {
		const path = join(dir, `shell-${Math.random().toString(36).slice(2)}`);
		writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${output}"\n`);
		chmodSync(path, 0o755);
		return path;
	}

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "menard-detect-test-"));
		executable = join(dir, "claude");
		writeFileSync(executable, "#!/bin/sh\nexit 0\n");
		chmodSync(executable, 0o755);
		plainFile = join(dir, "not-executable");
		writeFileSync(plainFile, "");
		chmodSync(plainFile, 0o644);
		folder = join(dir, "folder");
		mkdirSync(folder);
		missing = join(dir, "missing");
	});

	afterEach(() => {
		process.env.SHELL = shell;
		Platform.isDesktop = true;
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("prefers the configured path", async () => {
		const result = await detectClaude(` ${executable} `, { probeShell: false, candidates: [missing] });
		expect(result).toEqual({ path: executable, via: "setting", tried: [executable] });
	});

	it("expands ~ in the configured path", async () => {
		const home = process.env.HOME;
		process.env.HOME = dir;
		try {
			const result = await detectClaude("~/claude", { probeShell: false, candidates: [] });
			expect(result).toEqual({ path: executable, via: "setting", tried: [executable] });
		} finally {
			process.env.HOME = home;
		}
	});

	it("never accepts a relative configured path", async () => {
		const result = await detectClaude("claude", { probeShell: false, candidates: [missing] });
		expect(result).toEqual({ path: null, via: null, tried: ["claude", missing] });
	});

	it("falls back to the first executable candidate", async () => {
		const result = await detectClaude(missing, { probeShell: false, candidates: [plainFile, folder, executable] });
		expect(result).toEqual({ path: executable, via: "candidate", tried: [missing, plainFile, folder, executable] });
	});

	it("passes over an executable .cmd or .bat file", async () => {
		const batch = join(dir, "claude.CMD");
		writeFileSync(batch, "@echo off\r\n");
		chmodSync(batch, 0o755);
		const result = await detectClaude(batch, { probeShell: false, candidates: [executable] });
		expect(result).toEqual({ path: executable, via: "candidate", tried: [batch, executable] });
	});

	it("reports every path tried when nothing is found", async () => {
		const result = await detectClaude("", { probeShell: false, candidates: [missing, plainFile] });
		expect(result).toEqual({ path: null, via: null, tried: [missing, plainFile] });
	});

	it("probes the login shell only when asked", async () => {
		process.env.SHELL = fakeShell(executable);
		expect((await detectClaude("", { probeShell: false, candidates: [missing] })).path).toBeNull();
		const result = await detectClaude("", { probeShell: true, candidates: [missing] });
		expect(result.path).toBe(executable);
		expect(result.via).toBe("shell");
	});

	it("ignores a shell answer that is not an executable absolute path", async () => {
		process.env.SHELL = fakeShell("claude: aliased to npx claude");
		expect((await detectClaude("", { probeShell: true, candidates: [] })).path).toBeNull();
		process.env.SHELL = fakeShell(plainFile);
		expect((await detectClaude("", { probeShell: true, candidates: [] })).path).toBeNull();
	});

	it("gives up on a shell that hangs", async () => {
		const hanging = join(dir, "hanging-shell");
		writeFileSync(hanging, "#!/bin/sh\nexec sleep 30\n");
		chmodSync(hanging, 0o755);
		process.env.SHELL = hanging;
		const started = Date.now();
		expect((await detectClaude("", { probeShell: true, candidates: [] })).path).toBeNull();
		expect(Date.now() - started).toBeLessThan(6000);
	}, 10_000);

	it("refuses to run outside the desktop app", async () => {
		Platform.isDesktop = false;
		await expect(detectClaude(executable, { probeShell: false })).rejects.toSatisfy((error) => isMenardError(error, "desktop-only"));
	});
});
