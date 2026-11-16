# 0001. Alignment is stored in the Markdown, not in plugin data

- Status: Accepted
- Date: 2026-10-04

## Context

Menard needs to know which paragraph and which sentence of a source note corresponds to which in its translation note. That knowledge could live in the plugin's own `data.json`, in a sidecar file, or in the notes themselves. Plugin data does not travel with the notes through sync tools, is invisible to other tooling, and is lost when the plugin is uninstalled. The alignment is expensive to produce (it comes from a model call) and is part of the scholarly record of the pair.

## Decision

Alignment is written into the Markdown of the pair. Paragraph correspondence is expressed by matching block IDs (` ^p12`) on both notes. Sentence correspondence is expressed by one hidden `%% … %%` sentence map per paragraph in the translation note. Plugin data holds settings only.

## Consequences

- Alignment syncs, versions and backs up with the vault, and survives uninstalling Menard.
- Block IDs double as stable paragraph links (`[[@citekey#^p12]]`).
- Menard adds markup to the source note. It must hide block IDs in reading view and, by default, in Live Preview except on the cursor line.
- The sentence-map format must tolerate small edits to either note and changes to the sentence segmenter. Its exact encoding is an open design question.
- Other tools that rewrite notes must leave trailing block IDs and `%%` comments untouched.
