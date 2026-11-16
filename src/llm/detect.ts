/**
 * Locates the `claude` executable without installing anything.
 * Owner: llm module. DESIGN.md §10.1.
 */
import { Platform } from "obsidian";
import { MenardError } from "../errors";
import type { DetectResult } from "../types";

/** How long the login-shell probe may take. */
export const SHELL_PROBE_TIMEOUT_MS = 3000;

/** What `tried` lists for the login-shell probe. */
const SHELL_PROBE_LABEL = "$SHELL -lc 'command -v claude'";

/** Batch files, such as npm's `claude.cmd` shim, which Node refuses to spawn without a shell. */
const BATCH_FILE_RE = /\.(?:bat|cmd)$/i;

/** Candidate absolute paths, in order, for a home directory. Pure. */
export function candidatePaths(home: string, platform: string): string[] {
	const paths = [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
	if (platform === "win32") paths.push(`${home}\\.local\\bin\\claude.exe`);
	return paths;
}

/**
 * Checks `configured` (if non-empty; "~" expanded, absolute only), then the candidates, for an
 * executable file other than a `.cmd` or `.bat`, which cannot be spawned directly. With `probeShell`, finally runs `$SHELL -lc 'command -v
 * claude'` with a 3 s timeout (only on the user's explicit request).
 * Desktop only: throws MenardError("desktop-only") elsewhere.
 * `candidates` replaces the default list (tests use it).
 */
export async function detectClaude(configured: string, options: { probeShell: boolean; candidates?: readonly string[] }): Promise<DetectResult> {
	const { fs, os, cp, path: nodePath } = nodeModules();
	const tried: string[] = [];
	const executable = async (path: string): Promise<boolean> => {
		tried.push(path);
		if (BATCH_FILE_RE.test(path)) return false;
		try {
			if (!(await fs.promises.stat(path)).isFile()) return false;
			await fs.promises.access(path, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};

	// "~" is expanded; a relative path is never accepted, because the CLI runs in a temp directory.
	const setting = configured.trim().replace(/^~(?=$|[\\/])/, os.homedir());
	if (setting !== "") {
		if (!nodePath.isAbsolute(setting)) tried.push(setting);
		else if (await executable(setting)) return { path: setting, via: "setting", tried };
	}

	const candidates = options.candidates ?? candidatePaths(os.homedir(), process.platform);
	for (const candidate of candidates) {
		if (await executable(candidate)) return { path: candidate, via: "candidate", tried };
	}

	const shell = process.env.SHELL;
	if (options.probeShell && shell && process.platform !== "win32") {
		tried.push(SHELL_PROBE_LABEL);
		const found = await new Promise<string>((resolve) => {
			cp.execFile(shell, ["-lc", "command -v claude"], { timeout: SHELL_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
				resolve(error ? "" : stdout.trim().split("\n").pop()?.trim() ?? "");
			});
		});
		if (found.startsWith("/") && (await executable(found))) return { path: found, via: "shell", tried };
	}
	return { path: null, via: null, tried };
}

function nodeModules(): { fs: typeof import("fs"); os: typeof import("os"); cp: typeof import("child_process"); path: typeof import("path") } {
	if (!Platform.isDesktop) {
		throw new MenardError("desktop-only", "Finding Claude Code needs the desktop app.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- Node built-ins load lazily, after the Platform.isDesktop guard (DESIGN.md §3.1). */
	return {
		fs: require("fs") as typeof import("fs"),
		os: require("os") as typeof import("os"),
		cp: require("child_process") as typeof import("child_process"),
		path: require("path") as typeof import("path"),
	};
	/* eslint-enable @typescript-eslint/no-require-imports -- end of the guarded block. */
}
