# 0003. Two-note pair model; single-note layout only via split

- Status: Accepted
- Date: 2026-10-04

## Context

Some existing notes keep the original and the translation in one file under two headings (`# Text` and `# English translation`). A single-note model keeps everything together but makes each text harder to link, search, embed and edit on its own, and complicates rendering two independent panes. Supporting both layouts everywhere would double every code path.

## Decision

The only layout Menard reads is the pair: a source note and a translation note linked by frontmatter (`translation:` on the source, `source:` on the translation), with the translation named `<source name> (EN).md` beside the source. A one-time split command converts a single-note layout into a pair and aligns it in the process.

## Consequences

- Each text is a first-class note that can be linked, searched and edited independently.
- Views, commands and alignment logic handle one layout.
- Users with single-note texts must run split once per note before reading them in Menard.
- The vault gains a second note per text, which other tools must not treat as malformed.
