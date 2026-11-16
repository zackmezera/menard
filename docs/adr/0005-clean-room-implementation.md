# 0005. Clean-room implementation

- Status: Accepted
- Date: 2026-10-04

## Context

Several existing plugins touch nearby problems: interlinear display, selection translation, synchronized scrolling, word lists, parallel translation. They were surveyed and rejected as fork bases. Their licenses differ (MIT, GPL-3.0, 0BSD), and borrowing code from a GPL project would bind Menard's license, while borrowing from permissive ones would still carry attribution duties and design debt that does not fit the pair-and-alignment model.

## Decision

Menard is written from zero. No source code from other Obsidian plugins is read, copied or adapted during development. Obsidian's official API documentation, its published type definitions and the official sample-plugin project structure are the permitted references.

## Consequences

- Menard is MIT-licensed with no third-party attribution owed for plugin code.
- Every feature is designed around Menard's own model rather than retrofitted.
- Some solved problems (scroll sync, hover popovers) are re-solved, at some cost in time.
- Contributors are asked to follow the same rule.
