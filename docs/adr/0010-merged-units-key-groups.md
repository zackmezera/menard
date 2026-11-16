# 0010. A Menard line may name a key group: merged units

- Status: Accepted
- Date: 2026-10-05

## Context

A unit is one block on each side, paired by one key: the same block id on both notes (ADR 0006, DESIGN.md §4.2). Free and adapted translations do not keep the paragraphs of the original. Montero's *Signs of Borges* (1994, "translated and adapted") renders Molloy's eleven-paragraph Introducción in eight: three English paragraphs each render two Spanish ones (#36). With one key per block there was no way to say "Spanish p3 and p4 are English p3": a block holds one id, so the English paragraph cannot carry both, and the length-based matcher, which knew only 1-1, 1-0 and 0-1, shifted every later pair by one.

Three representations were considered.

- **No format change.** The merged paragraph takes the first source key; the second source paragraph keeps its own id with no partner, and the first unit's map links into it. The map would no longer describe its unit's words, the second paragraph would be reported as untranslated and offered to Translate note, and the reader could not highlight into it.
- **Two ids on one block.** Obsidian allows one block id per block.
- **A key group on the Menard line.** The line that holds the map (or the pending marker) names every key of the merged unit.

## Decision

A map or marker line may name a **key group**: two or more block ids joined by `+`, for example `%%menard:1 p3+p4 …%%`. The group names consecutive units read as one. Each side of the merged unit is the concatenation, in group order, of the blocks that side holds for the group's keys; a key may be present on one side only. Every paragraph keeps an id of its own:

- **2-1** (two source paragraphs, one translation paragraph): the source carries `^p3` and `^p4`; the translation's paragraph carries `^p3`; the line is `%%menard:1 p3+p4 …%%`. `p4` exists only in the source.
- **1-2** (one source paragraph rendered as two): the source carries `^p3`; the translation's two paragraphs carry `^p3` and a fresh `^p12` that the source does not use; the line is `%%menard:1 p3+p12 …%%`. `p12` exists only in the translation.

Up to three blocks may stand against one. Word counts run across a side's blocks in order, so a link may cross a paragraph boundary. The line stands after the side's last translation block. Footnote keys never group; every block of a group is a paragraph, quote or callout.

The format version stays `1`. A file without key groups reads exactly as before. A plugin version without this decision finds `+` outside its key grammar and reports the line as malformed, which ignores it (the first paragraph shows whole, the second as unpaired): never a misreading, so no new version number.

## Consequences

- The pair model builds one unit per group, keyed by its first key; `unit()` and `unitAtLine()` answer for every member. Each side lists its blocks (`PairUnit.group`), and anchors span them.
- Reading view tags every block of a merged side with the unit's key and wraps each block's share of each link under the same `<key>.<n>`; the share is found by fitting the whole side to its Markdown and cutting each link's range at the block boundary. Partner highlight, hover and held level need nothing else. Scroll sync measures a unit across all its elements; the stacked gloss renders every translation block of the unit.
- Check alignment, Refresh maps and Report a problem fit a merged side across its blocks. Translate note treats every key of a group as translated.
- Re-align keeps the group. Re-translate dissolves it: Menard's own translation goes paragraph for paragraph, so the merged translation and its map give way to one translated block and map per source paragraph.
- Deleting the group's line dissolves the merge: the first paragraphs pair whole, the rest show as unpaired.
- The aligner produces groups from a content-based paragraph pairing (DESIGN.md §7.2); a hand-written group is honoured when every key exists, no key is in another group, and each side has a block.
