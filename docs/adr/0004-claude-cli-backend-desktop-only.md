# 0004. v1 backend is the local `claude` CLI; desktop only

- Status: Accepted
- Date: 2026-10-04

## Context

Translation needs a capable model that can return structured, sentence-aligned output for long academic prose. The first user already pays for a Claude subscription that includes the `claude` command-line tool, so calling it costs nothing extra. Supporting API keys for several providers adds settings, secrets handling and testing surface before the reading experience itself is proven.

## Decision

In v1 the only translation backend is the local `claude` CLI, invoked non-interactively (`claude -p`) as a child process. Because Obsidian launched from the desktop does not inherit the shell `PATH`, the CLI is located through an absolute-path setting with auto-detection of common install locations. The plugin is marked `isDesktopOnly: true`. Menard discloses in its README and settings that it runs a local executable.

## Consequences

- No API key handling and no network code inside the plugin in v1.
- Users without Claude Code cannot translate; they can still split and read pairs they already have.
- Mobile is unavailable in v1, since spawning processes requires Node APIs.
- The backend sits behind an interface so that API providers (Anthropic, OpenAI-compatible) can be added later without touching the views.
- Authentication outside a terminal (keychain access from the Electron process) must be verified early.
