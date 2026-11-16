# 0009. Three write classes; user text is replaced only with a backup

- Status: Accepted
- Date: 2026-10-04

## Context

Menard writes into notes that hold scholarly work: it adds ids to the user's source text, creates translations, and, for split and re-translate, removes text. A bug in any of these must not lose a word. Writes also race with the user's own typing and with the nightly scripts.

## Decision

All note writes go through one module, `vault/writer.ts`, and each belongs to exactly one class:

1. **Insert-only.** Ids and markers. The writer verifies that removing the inserted ranges from the result yields the original text exactly.
2. **Menard-owned rewrite.** Replacing a marker with a translation or a map, or one Menard line with another. Every replaced range must be exactly one whole `%%menard:1 …%%` line.
3. **Backed-up replace.** Split and re-translate. The caller must hold a `BackupToken`, which only the backup store can create and only after saving a full copy of the file; the writer checks that the backup matches the current content and that every replaced slice still holds what the caller expected.

Every write is computed inside `vault.process` from the file's current text, so it never applies an edit to stale content. Reading, rendering and cursor movement never write; repaired alignment stays in memory until the user asks to refresh it.

## Consequences

- The safety logic is in one reviewable file, and the type system prevents a destructive write without a backup.
- A write whose anchor has moved or vanished becomes a conflict to retry, not a corruption.
- Backups accumulate in the plugin's folder under the config directory, pruned to a configurable count.
