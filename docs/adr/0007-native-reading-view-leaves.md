# 0007. Reading happens in native reading-view leaves

- Status: Accepted, gated by a performance spike
- Date: 2026-10-04

## Context

The facing and stacked views could be built as a custom `ItemView` that renders both notes with `MarkdownRenderer`, giving Menard full control of the DOM, or on Obsidian's own `MarkdownView` leaves in reading mode, decorated by a Markdown post-processor. A custom view must re-implement link clicks, hover previews, embeds and the switch to editing, and `getSectionInfo` is often unavailable in it. Native leaves keep all of that, but reading view is virtualized: only sections near the viewport exist in the DOM, so scroll sync and cursor stepping cannot assume every sentence is present.

## Decision

Both views use native `MarkdownView` leaves in reading mode. One post-processor wraps sentences in both notes. Sessions keep their state independent of the DOM, compute cursor order and scroll anchors from the Markdown, scroll by source line to reach unrendered sections, and repaint each section as it renders. The facing view is a vertical split of two such leaves; the stacked view is a mode of the source leaf.

The custom `ItemView` remains the named fallback for the facing view if spike S1 (docs/DESIGN.md §14) shows that holding the partner level across virtualized sections is too slow. The post-processor, wrapping and session code are written so that the fallback reuses them.

## Consequences

- Links, embeds, hover previews, footnotes and editing keep working with no Menard code.
- Cursor and scroll code must tolerate sections that are not rendered and wait for them.
- Menard depends on reading-view markup for skip selectors and scroll units; each such dependency is isolated in one place and covered by a spike.
