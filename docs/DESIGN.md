# Menard v1: design

Status: authoritative, 2026-10-04. This document supersedes the three candidate designs it was synthesized from. Where it and the code disagree, fix one of them in the same change. Vocabulary follows [CONTEXT.md](../CONTEXT.md); hard-to-reverse decisions are recorded in [docs/adr](adr/README.md).

Inputs: the product spec from the grilling session (`grill-menard-2026-10-04.md`), the Obsidian API research, the vault-compatibility and `claude` CLI research, and three candidate designs written independently for robustness, simplicity and reading experience.

## Contents

1. [How the design was chosen](#1-how-the-design-was-chosen)
2. [Resolved questions](#2-resolved-questions)
3. [Architecture](#3-architecture)
4. [On-disk format](#4-on-disk-format)
5. [Text pipeline](#5-text-pipeline)
6. [The pair model](#6-the-pair-model)
7. [Jobs](#7-jobs)
8. [Writing safely](#8-writing-safely)
9. [Reading](#9-reading)
10. [The claude CLI backend](#10-the-claude-cli-backend)
11. [Errors](#11-errors)
12. [Settings, commands, shared files](#12-settings-commands-shared-files)
13. [Testing](#13-testing)
14. [Verification spikes](#14-verification-spikes)
15. [Implementation modules](#15-implementation-modules)
16. [Import](#16-import)

---

## 1. How the design was chosen

Each candidate was scored from 1 (weak) to 5 (strong) on six criteria.

| Criterion | Robustness | Simplicity | Reading UX |
|---|---|---|---|
| Data safety | 5 | 3 | 3 |
| Spec fidelity | 4 | 4 | 3 |
| Simplicity | 2 | 5 | 2 |
| Reading experience | 3 | 3 | 5 |
| Testability | 5 | 4 | 4 |
| Reviewer acceptability | 4 | 5 | 3 |
| **Total** | **23** | **24** | **20** |

The simplicity design is the base. Its central idea removes most of the hard problems: the alignment unit is a *link* (a contiguous run of source words paired with a contiguous run of target words), maps record word positions rather than sentence ordinals, and both panes carry the same link key in a data attribute, so finding a partner is an attribute selector. Because maps store word counts, the reader never runs the segmenter, and a change to the segmenter or the abbreviation list cannot invalidate a map that already exists. The spec's open question asked for exactly that.

The reading-UX design lost points on one decisive issue: its maps store sentence ordinals and re-segment at read time, so a segmenter change turns maps stale. Its reading mechanics are the best of the three, and most of them are grafted here. The robustness design is the most careful about data but roughly doubles the module count; its safety mechanisms are grafted in reduced form.

What each candidate contributed:

- **From simplicity (base):** links as the single alignment unit; word-position maps; the shared link key; Menard lines that are prose-free and single-line; pure `format`-style modules for all string work; pending markers in the note as the job state; a fake `claude` binary for process tests.
- **From robustness:** a per-link, order-insensitive word-bag hash on each side of each link, so drift is localized to the sentence that changed and the nightly name rewrite ("Jacques Lacan" to `[[Lacan, Jacques]]`) is invisible to the map; a version tag in every Menard line; one writer module with three write classes (insert-only, Menard-owned rewrite, backed-up replace) and a branded backup token; placeholder protection of verbatim tokens in prompts; split verification by exact reconstruction; reciprocal frontmatter links before a note counts as a pair.
- **From reading UX:** state drives the DOM, so a section re-rendered by virtualization repaints itself; held level with a comfort band; scroll sync with driver election from user input and proportional placement within a paragraph; re-entry at the reading line after free scrolling; the stacked gloss rendered offscreen and cloned, which avoids balancing emphasis across sentence cuts; anchor-preserving reflow when the gloss moves; deterministic paragraph matching for align; CSS variables with forced-colors and reduced-motion support; the spike list that gates the views.

Dropped on purpose: batching several units per CLI call (one bad answer would fail several units), the Gale–Church offline aligner, line-mode flags in the map, user-configurable frontmatter key names, regex settings, the custom easing module, and a segmenter id in the map.

## 2. Resolved questions

**Name and id.** The display name is "Menard" for now and may change at any time before or after release. The plugin id `menard` is unused among the 8,405 community ids, contains no "obsidian", and becomes permanent at submission; the repository stays private until then.

**Sentence-map format.** Each paragraph's map is one line, `%%menard:1 <key> <link> <link> …%%`, where each link records the word count and a 4-character word-bag hash of its source side and its target side (§4.3, ADR 0006). It survives minor edits (typo fixes, punctuation, quote styles, the nightly name rewrite) exactly; a word added or removed in one sentence is re-anchored to that sentence by prefix and suffix matching; segmenter changes never affect it, because the reader does not segment. It carries no prose, so search and the nightly scripts have nothing to match. It costs about 16 characters per link, roughly 7 KB on the 137 KB @ruizalmotasim.

**Language-agnostic.** Yes. Each pair records its languages in the translation note's frontmatter (`sourceLanguage`, `targetLanguage`, BCP 47 codes). Settings hold the defaults, Spanish to English. Built-in abbreviation lists ship for `es` and `en`; other languages use plain `Intl.Segmenter` plus the user's abbreviation lines. The translation note's suffix is the uppercased target code, `(EN)`.

**Long texts.** One CLI call per unit, two in parallel by default (one to four). Before the first call, the translation note is created as a skeleton holding one pending marker per unit; each finished unit replaces its marker with one atomic `vault.process`. Progress shows in a persistent notice with a Cancel button and in the status bar. Cancel kills the child processes and leaves the remaining markers; running Translate note again resumes from them. A crash or reload loses only the units in flight.

**Assumptions from the spec, now checked.**

- *`claude` from Electron:* it works when the child environment has `HOME` and `USER` and the call uses `--safe-mode`; the binary is at an absolute path outside the GUI `PATH`, so Menard detects it and offers a path setting. A first-run keychain prompt from Obsidian remains to be seen (spike S6).
- *The nightly chain:* trailing ids are safe. `%%` blocks are not protected by `link_persons.py`, but Menard lines contain no capitalized words, so nothing in them can match. The translation note shows up as a false positive in the nightly report's "Texts not in the registry" list; the vault's `newNoteProperties` should set `collection: translation` so it stays out of `Texts.base` rows and satisfies the frontmatter check. Alignment keys on block ids, word counts and order-insensitive hashes, never on exact text.
- *Segmentation:* `Intl.Segmenter` applies untailored UAX #29. Menard segments the rendered projection rather than raw Markdown and adds a merge pass for abbreviations, initials and abbreviation-plus-digit (§5.3). Segmenter mistakes only make links slightly coarser or finer.
- *Reviewer acceptance:* `isDesktopOnly: true`, the `child_process` require behind `Platform.isDesktop`, and a README section disclosing network use, the external binary, and the account requirement. The `eslint-plugin-obsidianmd` rules run in CI from day one.

**Smaller decisions made here.** Lists and tables align as whole blocks, without sentence maps. Footnotes align by label, translated whole, without sentence maps. Headings pair through the paragraphs that follow them (§4.5). Align matches paragraphs deterministically, not with a model call. Settings are declarative only, so `minAppVersion` becomes 1.13.0.

---

## 3. Architecture

### 3.1 Layers

```
            ┌───────────── integration: main.ts, settings-tab.ts, styles.css ─────────────┐
            │                                                                              │
   reader (sessions, cursor, scroll sync, stacked, keys)        jobs (translate, align, split, check)
            │                                                         │            │
   render (post-processor, DOM projection, wrap, gloss, Live Preview) │            │
            │                                                         │            │
            └──────────────► vault (PairStore, SafeWriter, backups) ◄─┘            │
                                         │                                       llm (CLI, prompts, validation)
                         align (maps, signatures, reconcile, model, match)
                                         │
                         text (blocks, projection, segmentation, ids, edits)
```

**Purity.** `text/`, `align/`, `llm/{envelope,protect,prompts,validate}.ts`, `jobs/{skeleton,assemble,split-plan}.ts`, `reader/{cursor,geometry}.ts`, `vault/properties.ts`, `diagnose/report.ts`, and the shared `types.ts`, `constants.ts`, `errors.ts`, `settings.ts` import nothing from Obsidian, CodeMirror, the DOM or Node at runtime. A lint rule enforces this. Purity is what makes them unit-testable in plain vitest.

**Write ownership.** Only `vault/writer.ts` and `vault/backup.ts` modify files. Jobs compute edits as functions of the current text and hand them to the writer. The reader and the renderer never write.

**Node ownership.** Only `llm/detect.ts` and `llm/claude-cli.ts` touch Node built-ins, each through `require` inside a function that first checks `Platform.isDesktop`.

### 3.2 Source tree and owners

| Path | Module | Pure |
|---|---|---|
| `src/types.ts`, `src/constants.ts`, `src/errors.ts`, `src/settings.ts` | shared (design) | yes |
| `src/text/{blocks,inline,segment,abbreviations,ids,edits}.ts` | text | yes |
| `src/align/{words,signature,map,reconcile,cuts,model,match}.ts` | align | yes |
| `src/llm/{detect,claude-cli}.ts` | llm | no |
| `src/llm/{envelope,protect,prompts,validate}.ts` | llm | yes |
| `src/vault/{writer,backup,pairs}.ts` | vault | no |
| `src/vault/properties.ts` | vault | yes |
| `src/jobs/{controller,queue,progress,translate,align,split,retranslate,check,modals}.ts` | jobs | no |
| `src/jobs/{skeleton,assemble,split-plan}.ts` | jobs | yes |
| `src/render/{postprocessor,dom-projection,wrap,gloss,live-preview}.ts` | render | no |
| `src/reader/{sessions,session,scroll-sync,stacked,pointer,keys,facing}.ts` | reader | no |
| `src/reader/{cursor,geometry}.ts` | reader | yes |
| `src/diagnose/report.ts` | diagnose | yes |
| `src/diagnose/{collect,modal}.ts` | diagnose | no |
| `src/import/{zip,epub,pdf,pages}.ts` | import | yes (DOM parsing only) |
| `src/import/commands.ts` | import | no |
| `src/main.ts`, `src/settings-tab.ts`, `styles.css`, `README.md` | integration | no |

---

## 4. On-disk format

Everything Menard knows about a pair lives in the two notes (ADR 0001). Plugin data holds settings only.

### 4.1 Pair linkage

The source note carries `translation: "[[@ruizalmotasim (EN)]]"`. The translation note carries:

```yaml
source: "[[@ruizalmotasim]]"
sourceLanguage: es
targetLanguage: en
```

plus any `key: value` lines from the `newNoteProperties` setting (this vault: `collection: translation`). Menard never copies `textStatus`, `citekey` or `collection` from the source. Keys are fixed (`FM` in `constants.ts`) and written only through `fileManager.processFrontMatter`, touching nothing else.

A note is part of a pair only when both links resolve (`metadataCache.getFirstLinkpathDest`) and point at each other. A web clipping with `source: https://…` therefore never looks like a translation note, and Menard never adds ids to a note that merely has one of the keys. A one-sided link is reported by Check alignment, which offers to repair it.

The translation note's path is `<source folder>/<source basename> (<TARGET>).md`.

### 4.2 Units and block ids

A *unit* is a block Menard aligns. The text module classifies every block of the **text region**: everything after the frontmatter (or after the `textStartHeading` heading, when set) that is not under a skipped heading.

**Safe default start (#26).** When `textStartHeading` is empty, `parseOptions` sets `autoTextStart` for source notes (never for translation notes, which `parseTarget` parses from the frontmatter). The text then starts after a heading named `Text` (any level, case-insensitive) when the note has one. Otherwise the preamble is the leading run of metadata-only blocks: verbatim blocks (embed lines such as `![[Text.base]]`, comments, HTML, thematic breaks, code), and paragraphs or lists whose every line, ignoring list markers and symbols such as 🔗, is only links, wikilinks, embeds, autolinks, bare URLs, inline code (Meta Bind `` `BUTTON[…]` ``), bare `BUTTON[…]`, comments or a block id. The run ends at the first heading, quote, callout, table, footnote, or paragraph with a word of prose; callouts are never preamble, since an abstract or provenance note may be text. The rule is deliberately conservative: a prose line before the text (a citation, class notes) stays text, and such notes should use a `Text` heading or the setting. If any block that would become preamble already carries a Menard id (`^pN`), the rule is off for that note and the whole note stays text, so pairs translated under the old default keep their units. The Translate preflight shows the start of the first text unit so the reader can see where the text begins.

| Block | Unit kind | Key | Id placement | Sentence map |
|---|---|---|---|---|
| Paragraph (lines up to a blank line) | `paragraph` | block id | ` ^p12` at the end of the last line | yes |
| Blockquote, including verse and attribution lines | `quote` | block id | `^p12` on its own line, blank line before and after | yes |
| Callout | `callout` | block id | own line | yes (body only) |
| List (the whole list) | `list` | block id | own line | no |
| Table | `table` | block id | own line | no |
| Footnote definition with its continuation lines | `footnote` | `fn:<label>` | none | no |
| Heading | `heading` | `h:<n>`, memory only (§4.5) | none | no |
| Code, math, HTML, embed-only line, `---`, a user's `%%` block | verbatim | none | none | no |
| A Menard line | menard | none | none | — |

Id rules:

- Menard allocates `p<n>`, starting above the highest `p<n>` in the note and skipping any id already used anywhere in it. It never renumbers, because ids are link targets (`[[@ruizalmotasim#^p12]]`). Order always comes from position in the file, never from the number.
- A unit that already ends with a user's id (`^intro-1`) keeps it, and that id becomes the pair key on both notes. A block can hold only one id, so Menard never adds a second one, and it never renames or removes an id it did not create.
- A trailing id goes after the last line's content, after any inline comment: `… añadidura %%p. 2%% ^p1` (spike S7). A hard-break line keeps its two trailing spaces and the id follows a single space.
- Ids exist on both notes with the same key. An id present on one side only marks an unpaired unit.
- Skipped sections default to Bibliografía, Bibliography, Obras citadas, Works cited, Referencias, References. This vault adds Argument and For My Work, and sets the text start heading to `Text`.

### 4.3 Menard lines and the sentence map

Menard owns whole lines that begin `%%menard:1 `. There are two kinds: the sentence map of a unit, and a pending-task marker. Each is its own block, with a blank line before and after, never inline, never inside a list, quote or callout. In the translation note, a unit's map goes directly after the unit (after its own-line id, if any). Placement is advisory: lines are matched to units by the key inside them.

**Grammar (ABNF, RFC 5234):**

```abnf
menard-line = "%%menard:1" SP key SP body "%%"        ; the whole line; no other text on it
key         = block-id / "fn:" label / key-group
key-group   = block-id 1*( "+" block-id )             ; a merged unit (ADR 0010); no id twice
block-id    = 1*( ALPHA / DIGIT / "-" )
label       = 1*( ALPHA / DIGIT / "-" / "_" )
body        = "translate" / "align" / links
links       = link *( SP link )
link        = side "/" side [ "?" ]                   ; source side "/" target side; "?" = loose
side        = "-" / count "." hash                    ; "-" = this side is empty (a flagged span)
count       = %x31-39 *3DIGIT                         ; words on this side, 1–9999
hash        = 4( DIGIT / %x61-7A )                    ; lower-case base 36
```

Constraints the validator enforces: at least one link; no link with both sides `-`; no `%` or newline inside the body; at most one map per key. A malformed Menard line is reported and ignored, never rewritten.

**Ownership (#35).** Whether a line is Menard's is decided once: `constants.ts#isMenardLine` (the whole line, nothing before or after it, not even trailing whitespace; such a line is a plain user comment to every module alike), and only where `text/blocks.ts` reads a block, so never inside fenced code or a user's multi-line `%%` block. A Menard-looking line inside such a block does not close it. `text/edits.ts#locateMenardLines`, which jobs and the writer use, returns exactly the `menard` blocks of `parseNote`, so what the reader reads and what a job may rewrite are the same lines.

**Merged units (ADR 0010).** A key group names consecutive units read as one, because the translation merged or split paragraphs. Each side of the merged unit is the concatenation, in group order, of the blocks that side holds for the group's keys; a key may exist on one side only. Every paragraph keeps its own id. When two Spanish paragraphs became one English paragraph (2-1), the source carries `^p3` and `^p4`, the translation `^p3`, and the line after it is `%%menard:1 p3+p4 …%%`. When one became two (1-2), the source carries `^p3`, the translation `^p3` and a fresh `^p12` the source does not use, and the line after the second is `%%menard:1 p3+p12 …%%`. Counts run across a side's blocks in order, so a link may cross a paragraph boundary. A group holds at most three blocks against one, all paragraphs, quotes or callouts; footnote keys never group. Markers may name a group too (`%%menard:1 p3+p4 align%%`). A key in two groups, or a group with no block on one side, is reported and ignored, as is a plain line for a key that a group claims.

**Words.** A word is a maximal run of `[\p{L}\p{N}\p{M}]` in a unit's **projection**, the NFC text a reader sees (§5.2). Punctuation, emphasis markers, footnote refs, inline comments and link syntax are not words. "Borges's" is two words and "1919-1929" is two; both projections agree, which is all that matters.

**Hash.** Each word is normalized (NFKD, combining marks removed, lower-cased). The side's hash is FNV-1a 32 over the UTF-16 code units of the normalized words *sorted* and joined by single spaces, reduced modulo 36⁴ and written as 4 base-36 digits, zero-padded. Sorting makes the hash order-insensitive.

**Link semantics.** Links partition both sides in order: link *i* covers the next `count` source words and the next `count` target words after link *i−1*. One source sentence translated as two English sentences is one link (1→n); two fused into one is one link (n→1). A link with an empty side is a flagged span: text with no counterpart. `?` marks a correspondence the aligner judged approximate.

**Example (real prose).** The first two sentences of *Don Quijote* I.1 (1605) and John Ormsby's 1885 translation, both public domain. A footnote ref and an inline page marker are added to show that neither counts as words.

Source note:

```markdown
En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.[^1] Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de %%p. 2%% añadidura los domingos, consumían las tres partes de su hacienda. ^p1
```

Translation note:

```markdown
In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.[^1] An olla of rather more beef than mutton, a salad on most nights, scraps on Saturdays, lentils on Fridays, and a pigeon or so extra %%p. 2%% on Sundays, made away with three-quarters of his income. ^p1

%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%
```

Variants of the same paragraph:

| Situation | Map |
|---|---|
| 1→1, 1→1 (above) | `%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%` |
| 1→n: the second sentence rendered as two ("…extra on Sundays. These made away with three-quarters of his income.") | `%%menard:1 p1 33.myfp/46.6ton 33.7teg/36.xsyq%%` |
| n→1: both sentences fused into one free 61-word English sentence | `%%menard:1 p1 66.j87o/61.abc0%%` |
| The same, judged approximate | `%%menard:1 p1 66.j87o/61.abc0?%%` |
| A translator's addition "[An olla is a slow-cooked stew.]" after the second sentence | `%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r -/7.e5eo%%` |
| Translation still to be written here | `%%menard:1 p2 translate%%` |
| Unit above exists, map still to be made (align) | `%%menard:1 p3 align%%` |
| Footnote still to be translated | `%%menard:1 fn:1 translate%%` |

**Known-answer vectors** (these are test cases for `align/signature.ts`):

| Input | Signature |
|---|---|
| `fnv1a32("")`, `fnv1a32("a")`, `fnv1a32("foobar")` | `0x811c9dc5`, `0xe40c292c`, `0xbf9cf968` |
| Quijote sentence 1 (Spanish above) | `33.myfp` |
| Quijote sentence 2, with or without `%%p. 2%%` | `33.7teg` |
| Ormsby sentence 1 | `46.6ton` |
| Ormsby sentence 2 | `35.ny2r` |
| `Como señala Jacques Lacan, el deseo es el deseo del Otro.` | `11.grrx` |
| `Como señala Lacan, Jacques, el deseo es el deseo del Otro.` (the nightly rewrite, as rendered) | `11.grrx` |
| `Como señala Jacques Lacan, el deseo es el deceo del Otro.` (a typo) | `11.k379` |

### 4.4 Fitting a map to changed text

Reading never writes (ADR 0009). When a unit renders, `align/reconcile.ts` fits each stored side to the current words:

1. **Fast path.** If the counts sum to the word total and every link's window hashes to its stored hash, the side is `exact`.
2. **Prefix.** From the start, accept links while the window at the current offset has the stored count and hash.
3. **Suffix.** From the end, accept links the same way, never crossing the prefix.
4. **The gap.** The unmatched links in the middle share the unmatched words.
   - One link left: it takes the whole gap and is `edited`. A typo fix that adds a word, or any edit inside one sentence, lands here, and every other sentence stays exact.
   - Several links left: the gap is divided in proportion to their stored counts, each cut snapped to the nearest word boundary within three words that follows `.?!…` (optionally with closing quotes or brackets). These links are `approximate`.
   - No words left: the links are `lost`.
   - All links matched but words remain: the extra words join the preceding link, which becomes `edited`.
5. **Nothing anchored.** If no link matched and there is more than one, every link is `lost` and the side is `degraded`: the reader highlights the unit as a whole.

The side's status is `exact`, `repaired` (only `edited` links), or `degraded` (any `approximate` or `lost`). Approximate links render with a dashed underline, so a guessed position never looks certain. Check alignment lists repaired and degraded units; "Refresh maps" rewrites repaired maps from current text without Claude, and "Realign" sends degraded ones back to Claude.

**From word ranges to text.** `align/cuts.ts` converts per-link word ranges into character ranges of a projection by the token-start rule: the cut before link *i+1* is the start of the whitespace-delimited token that holds its first word, so opening `«“¿¡(` travel with the sentence they open and closing `.»”)` and footnote refs stay with the sentence they close. The DOM wrapper and the stacked gloss both use it.

### 4.5 Footnotes and headings

Footnotes pair by label. Translate and split make translation labels equal to source labels (`[^3]` with `[^3]`). Align leaves labels alone and pairs them through `footnoteKey`, which drops a common alphabetic prefix (`en-3` and `gen-3` both pair with `3`). Footnote definitions are translated whole, have no sentence map, and are not cursor stops; clicking a footnote ref in a facing session highlights the partner definition. Sentence-level footnotes are a long-term issue.

Headings pair through the paragraphs they introduce: a heading pairs with the other note's heading that immediately precedes the partner of the first paired unit following it, so a title, a `Text` heading or a translator's heading that only one note has leaves the rest matched. A heading with no such match stays unpaired and scroll sync parks across it. They carry no ids (Obsidian excludes them), are keyed `h:<n>` in memory only, and serve as scroll-sync anchors.

### 4.6 A translation note, in full

```markdown
---
source: "[[@cervantesquijote1605]]"
sourceLanguage: es
targetLanguage: en
collection: translation
---
## Chapter One

In a village of La Mancha, … for coursing.[^1] An olla of … three-quarters of his income. ^p1

%%menard:1 p1 33.myfp/46.6ton 33.7teg/35.ny2r%%

%%menard:1 p2 translate%%

> …

^p3

%%menard:1 p3 …%%

[^1]: …
```

The source's preamble (title, buttons, Zotero link, base embed) and its skipped sections are not copied. Verbatim blocks in the text region are copied unchanged.

---

## 5. Text pipeline

### 5.1 Blocks

`text/blocks.ts#parseNote` scans a note line by line into `Block`s (`types.ts`). It detects EOL style, frontmatter, the text region, headings at any level, paragraphs by blank lines (hard-wrapped lines are one paragraph), quotes (blank `>` lines stay inside), callouts, lists, tables, footnote definitions with four-space continuation (including a nested `    > ` quote), code fences, `$$` blocks, HTML blocks, embed-only lines, thematic breaks, `%%` comment blocks and Menard lines. It strips each block's id into `id`, `idStyle` and `idLine`. Code fences that contain `^p1` or `%%menard` are verbatim and their content is never treated as ids or Menard lines.

### 5.2 Projection, on both sides

Alignment is defined on the projection. Two functions produce it and must agree word for word:

- `text/inline.ts#projectMarkdown` (pure), used when writing maps and building prompts. It drops footnote refs, inline `%%…%%`, inline code and math, embeds, HTML tags, emphasis and highlight markers; keeps link display text (`[[a|b]]` → `b`, `[[a]]` → `a`, `[[a#h]]` → `a > h`, `[t](u)` → `t`); resolves escapes; and keeps `\n` for line breaks. It returns an offset table back into the Markdown, so sentence slices and gloss cuts can be taken from the Markdown.
- `render/dom-projection.ts#projectElement`, used in reading view. A `TreeWalker` collects text nodes, skipping the selectors in one exported constant (`sup.footnote-ref`, `code`, `pre`, `.math`, `.internal-embed`, `.markdown-embed`, `.callout-title`, `.menard-gloss`, `.menard-ghost`; spike S3 confirms them). It inserts a virtual `\n` at each `<br>` and block boundary.

The words are what must agree; whitespace and punctuation differences are harmless. A parity test runs both over the same fixtures (§13). If they ever disagree on a real note, reconciliation absorbs it as an edit to one link rather than as a wrong highlight.

### 5.3 Segmentation

Segmentation runs only when a map is written, never while reading. `text/segment.ts#segmentSentences` takes a projection and returns sentence ranges:

1. `Intl.Segmenter(lang, {granularity: "sentence"})`, one cached instance per language.
2. Merge a boundary away when the text before it ends with an abbreviation from the language list or the user's additions followed by `.`; with a single capital letter and `.` (initials); or with `.` when the next sentence starts with a digit and the preceding token is at most four letters (`p. 14`). Also merge when the next segment starts with a closing bracket or quote, or a lower-case letter, or when a segment has fewer than two words. Two exceptions (#34): a lower-case single letter before `.` is a word, not an abbreviation, when a capitalized word other than a roman numeral follows (`la letra a. Luego`, `hacia d. Se pregunta`, but `s. XIX`, `t. II`, `p. 14` still join; a capital stays an initial, so `la letra A. Luego` remains one sentence); and a closing bracket or quote typed after a space (`literature. ) To assume`, an OCR or typing slip) closes the sentence before it when a capitalized word follows, rather than joining the next one. A period typed after a space (`weak . The next`) already ends a sentence.
3. With `splitDialogue`, split before ` —` that follows sentence-final punctuation.
4. `lineBreaks: "space"` (paragraphs) treats `\n` as a space; `"boundary"` (quotes, callouts) makes each line a sentence, which segments verse by line. UAX #29 already breaks at a newline, so the paragraph rule replaces `\n` with a space before calling the segmenter.

Built-in Spanish abbreviations: `sr sra srta dr dra d dña ud uds p pp n nn núm vol vols cap caps s ss ed eds trad cf ej etc fig art op cit ib ibid id col cols t vid apud`. English: `mr mrs ms dr st p pp n no vol vols ed eds trans ch cf etc fig e.g i.e ibid op cit ca vs`.

Example (synthetic academic Spanish):

```
Según el Sr. Pérez (cf. pp. 23-25), J. L. Borges leyó a Poe en Ginebra. Esa lectura, dice, fue decisiva.
```

Untailored ICU returns six segments, breaking after `Sr.`, `pp.`, `J.` and `L.`. After the merge pass there are two sentences. Mistakes that remain only change granularity: Claude receives numbered sentences and returns groups of them, so a missed split yields a coarser link, never a misalignment.

`segment.ts#sentenceMarkdown` cuts the Markdown into one slice per sentence at the input offset of each next sentence's first character, so a footnote ref after a period stays with the sentence it closes.

---

## 6. The pair model

`align/model.ts#buildPairModel` is pure. From both notes' `NoteStructure`s it pairs units by key, footnotes by `footnoteKey`, and headings by the next paired unit (§4.5); parses the target's Menard lines; attaches each map and pending marker to its unit; and collects malformed or orphaned lines as `problems`. It computes:

- `stops()`: the cursor order. Units in source order; for a unit with a usable map, one stop per link whose source side is non-empty; otherwise one whole-unit stop. Footnotes and headings are not stops. Counts come from the map, so stepping works through sections that are not rendered.
- `anchors()`: line ranges of paired units and headings on both sides, for scroll sync.
- `unitAtLine(side, line)`: the unit covering a line, used by the post-processor (`getSectionInfo(el).lineStart`) and by editor commands.

A key group on a Menard line (§4.3) makes one **merged unit**, keyed by the group's first key: `unit()` and `unitAtLine()` answer for every key and every line of its blocks, `PairUnit.group` lists each side's blocks in order (`unitBlocks`), and its anchors span from the first block to the last. `align/merge.ts` fits a merged side across its blocks (`fitUnitSide`) and gives each block its share of every link (`blockShare`), which is what reading view wraps.

`vault/pairs.ts#PairStore` resolves pairs from frontmatter, builds models from `vault.cachedRead` of both notes, caches them by path, and rebuilds on `metadataCache` `changed`, rename and delete, debounced 250 ms. `saveSettings` calls `PairStore.settingsChanged()`, which marks every cached pair stale (`invalidateAll`) when a setting the models are built from changed (`textStartHeading`, `skipHeadings`, the default languages), so the same debounced rebuild and notification repaint open views; the reader's `settingsChanged` follows. It bumps `version` on each rebuild and notifies listeners, which re-render open leaves of the pair.

---

## 7. Jobs

All jobs run through `jobs/controller.ts#JobController`, one job at a time per vault. Every job is resumable from Menard lines in the translation note, so no job state is stored anywhere else (ADR 0008).

### 7.1 Translate note

Available on a note that is not a translation note.

1. **Detect** the CLI; stop with an actionable notice if it is missing.
2. **Preflight modal**: source, languages (editable), model, unit count, ids to add, the first words of the first text unit, skipped sections, estimated time, and the disclosure "The text of this note will be sent to Anthropic through your local Claude Code installation." If a translation note exists and is linked, the modal offers to resume instead, with the pair's languages fixed.

   **Language checks (#25, `jobs/language.ts`).** The proposed source language is the source note's declared language when it has one (`originalLanguage`, then `language`, then `lang`; a name such as `spanish`/`Español`, or a BCP 47 code), else `defaultSourceLanguage`; the target is `defaultTargetLanguage`, or `defaultSourceLanguage` when the note is already in the default target language. A dependency-free stopword guess (en, es, fr, de, it, pt; at least 20 words, the best language's stopwords at least 15% of the words and 1.25 times the runner-up's, else no guess) runs over the projected text units of a new pair. When the guess disagrees with the source field, the modal warns ("The text looks like English, not Spanish.") and offers "Swap languages" when the guess is the target, or "Use <language> as the source" otherwise. Source and target of the same language (primary subtag, so `en`/`en-GB` count) are refused in the modal and again by the job.
3. **Ids.** One insert-only write adds missing ids to the source's units.
4. **Translation note.** If it does not exist: one outline call translates every heading in the text region (an answer that stays invalid keeps the source headings so the job goes on; this is logged once, and Report a problem lists paired headings that read the same in both notes); `jobs/skeleton.ts` builds frontmatter, headings, copied verbatim blocks and one `translate` marker per unit (footnote markers last); the writer creates the note; both frontmatter links are set. If it exists, markers are inserted for any source unit that has neither a translation nor a marker, after the translation of the nearest preceding paired unit (insert-only). A note that exists but is not linked back is refused with a pointer to Align.
5. **Tasks.** One task per `translate` marker, in document order, through the queue. A sentence unit: segment its projection, cut Markdown slices, protect each slice, build the prompt with the previous unit as context, call, validate (retrying with feedback), restore, assemble the block and the map (`jobs/assemble.ts`), and replace the marker with `block`, blank line, map line. A list, table or footnote: one plain call, validated for structure, replacing the marker with the block. Each write re-reads the current source text for that unit, so edits made during a long job are honoured.
6. **Summary.** "Translated 72 of 74; 2 failed. Run Translate note again to retry." with a button to open the facing view.

Map assembly: target groups are joined with single spaces, so the character offset where each group starts is known. Projecting the assembled block once and counting the words before each group's start gives the target counts; the source counts come from the sentence ranges each group covers. Hashes are computed from the same word lists. The map therefore matches the written text by construction.

Callouts: the header keeps its type; its title is translated in the same call (`calloutTitle`). Quotes: lines are protected as `⟦BR⟧` and blank quote lines as `⟦P⟧`; assembly rebuilds the `> ` prefixes.

### 7.2 Align with existing translation

Available on a source note. The translation note comes from `translation:` or a note picker. **It never changes a word of either note**: the only writes are ids, `align` markers, maps and frontmatter links.

1. **Unit matching** (`align/match.ts`, pure). Both notes' text-region units are split into sections by heading, sections paired by order, under the shift of heading numbers that costs least (a title or preface heading only one note has shifts every later section by one). Within each pair of sections, a dynamic program over moves 1-1, 2-1, 1-2, 1-0 and 0-1 scores kind mismatch (quote against paragraph is never matched; only paragraphs, quotes and callouts of one kind merge), length-ratio deviation from the section's own median, and shared anchors (digit runs, footnote keys, capitalized tokens over three letters, which survive translation). Skipping costs a constant; a merge adds a penalty, so two units merge only when that fits clearly better than pairing one and skipping the other. Identical kind sequences give the diagonal, which is the case for the vault's three combined notes. A move above a cost threshold is marked doubtful. Footnotes pair by `footnoteKey`.
2. **Paragraph pairing by content (#36).** Length is a weak signal for a free or adapted translation, and capitalized anchors are weak when one name is everywhere. So for every section pair whose units are not the plain diagonal (counts or kinds differ), Align asks Claude once to pair the units by content, before the preview: each unit is sent indexed, with its kind, word count and an excerpt (its first 40 words and, when longer, its last 10). The answer, `{groups: [{src: int[], tgt: int[]}]}`, may pair one with one, two or three consecutive units with one (2-1, 3-1, 1-2, 1-3), or leave a unit on either side alone. It is validated like the sentence pass (both sides covered once, contiguous, monotone), plus: never several against several, at most three merged, only paragraphs, quotes and callouts of one kind merge, a quote never pairs with a paragraph. Invalid answers retry with feedback; a section whose call still fails, or every section when there is no answer, falls back to the dynamic program, with a notice. Units the answer leaves alone are unpaired.
3. **Preview modal**: per-section counts ("6 sections, 68 paired, 4 source-only, 2 translation-only"), the merged pairs ("Read as one paragraph: Detenerse en… + La superstición… / To undo the habit…") and the doubtful pairs with their first words. Confirm or cancel.
4. **Writes.** Insert-only ids on both notes (a user id on either side is reused on the other, unless the other side already uses it, in which case both get a fresh `p<n>`); every block of a merged unit gets its own id, which the other note must not use (§4.3, ADR 0010); an `align` marker after each paired sentence unit in the translation note, naming the key group for a merged unit; the frontmatter links. **Two notes, two writes (#33).** Each note's write is atomic, the pair's is not, so the order is chosen to make a rerun the recovery: the source's ids are written first, then the translation's ids and markers, then the links. A failure or a conflicting edit after the first write leaves source ids with no partner, which read as unpaired units and break nothing; running Align again re-plans from both notes, takes each paired source block's id as its key, and writes exactly what an uninterrupted run would have. For that, fresh ids are numbered for the source first and for translation-only blocks (the extra paragraph of a 1-2 unit) last, so the rerun allocates the same numbers above the ids already written. A rerun asks Claude to pair paragraphs again; an answer that differs gives a different but consistent alignment, never a half-applied one. A rollback from a backup was rejected: it needs a third write that can fail the same way, and it cannot run after a crash.
5. **Sentence pass.** One task per `align` marker: segment both sides (each block of a merged side on its own, read in order), send numbered sentences of both (projection text only), validate that the groups cover both sides exactly once, contiguously and monotonically, and replace the marker with the map. Either side of a group may be empty: that is a flagged span, never forced into a match. The prompt asks for a sentence with no counterpart (a quotation the translator left out) to be its own source-only group, never grouped with a neighbour. One loose link over a whole unit with more than 40 words on either side is not trusted: it is written as two flagged spans, source-only and translation-only, so a doubtful pairing is never passed off as approximate.

### 7.3 Split combined note

Available on a note containing the `translationHeading` (default "English translation") at any level.

`jobs/split-plan.ts#planSplit` (pure):

1. Find the boundary heading by text at any level (H1 in @ruizalmotasim and @giordanoresistencia, H2 in @borgessupersticiosa1932).
2. The translation region runs from the boundary to the next heading of the same or a higher level, a skipped heading (`Argument`, `For My Work` stay in the source), or the end.
3. Refuse when there is no boundary; when the source region holds no units (@borgesversiones1932 is English only); when the region holds no units; or when a translation note already exists at the target path.
4. Footnote definitions move with the region when only the region cites them, stay when only the source does, and, when both cite one, stay in the source and are copied into the translation, so neither note keeps a reference without its definition.
5. Footnote labels: if every label in the region shares one alphabetic prefix (`en-`, `gen-`) and stripping it gives exactly the source's labels, rename refs and definitions to the source labels. If that would collide, refuse.
6. Verify: re-inserting the region (with labels un-renamed) into the new source text must reproduce the original byte for byte. Otherwise refuse with `split-verification-failed`.

Execution (`jobs/split.ts`): confirmation modal ("Move 23 blocks and 19 footnotes into the new translation note. Rename footnotes [^en-n] to [^n]. A backup of the original is saved.", plus "Copy 2 footnotes both texts cite; they stay in the source too." when definitions are shared, so copied footnotes are never counted as moved) with the same editable language fields and checks as the Translate preflight, the guess run on both halves (a translation half that does not look like the target is warned about too), and the new note's name following the target field; the confirmed languages name the translation note (re-checked for an existing note) and go into its frontmatter; back up the source; create the translation note and read it back; replace the region in the source with the backup token and the full original text as `expect` (if the user typed in between, the write aborts and the new note is trashed); set the frontmatter links; continue into Align from step 1. Translation-only material (the provenance callout, an affiliation line, the author's own abstract) moves over unchanged and is paired or left unpaired by the matcher.

### 7.4 Queue, progress, cancel, resume

`jobs/queue.ts` runs tasks with `concurrency` workers (default 2). Each job has one `AbortController`; cancelling it, the notice's Cancel button, the Cancel command and plugin unload all kill the children. Results already validated are still written; units in flight are discarded and keep their markers. Job-fatal errors (`cli-not-found`, `cli-not-logged-in`, `cli-rate-limited`, `desktop-only`) stop the whole job; other failures are recorded per unit and the job continues. `jobs/progress.ts` keeps one `Notice` with duration 0, rebuilt at most four times a second ("Translating @ruizalmotasim: 23 of 74 · 2 running · 1 failed [Cancel]"), mirrored in a status-bar item.

### 7.5 Re-translate and re-align one unit

The unit comes from the reading cursor, or from the editor cursor's line in either note through `unitAtLine`. Re-translate checks whether the translation's current words still match the map's target side; if not, the reader edited it, and a modal asks before replacing ("This paragraph was edited after translation. Replace it? A backup is saved."). A unit without a map (a list, table or footnote, or a sentence unit that lost its map) cannot be checked and always asks. If the translation changes while Claude is answering, it asks again before writing. Either way the translation note is backed up and the block and its map are replaced in one write. Re-align replaces the map with an `align` marker and runs the sentence pass for that unit.

A merged unit (ADR 0010), addressed by any of its keys, re-aligns as one, keeping its key group. Re-translate dissolves it: each source paragraph is translated on its own, as Translate note would, and the merged translation blocks and their map are replaced, in one backed-up write, by one translated block and map per source paragraph.

### 7.6 Check alignment

A read-only report modal: unpaired units on each side, pending markers, repaired maps, degraded maps, malformed or orphaned Menard lines, a one-sided frontmatter link. A merged unit is one unit; its sides are fitted across their blocks, and its other keys are never reported as untranslated or unpaired. Actions: Refresh repaired maps (rewrites counts and hashes from current text, keeping the link structure, no Claude), Realign degraded units, Repair pair link, Resume translation.

### 7.7 Translate or align a folder

From the active note's folder (command) or a folder's file menu. `jobs/batch.ts#planBatch` lists the Markdown notes directly in the folder, in name order, leaving out translation notes (linked back, or with a `source:` link), a note that is another's same-named translation (`X (EN).md` beside `X.md`, by the target language) and notes without text units. Each gets one action: **translate** (no translation note), **align** (an unlinked same-named translation exists; or a linked pair with `align` markers, with a paired sentence unit that has no map, or with no Menard line at all), **resume** (a linked pair with `translate` markers), or **done** (none of these: skipped). A linked pair's missing paragraphs are not translated by the batch, since an adapted translation leaves some out on purpose; Translate note on that note still does it.

One preflight for the batch: the languages once (pairs that exist keep their own), one line per note with its action and a rough call count (the units to translate or align), the network disclosure. Then each note runs its ordinary job, Translate note or Align with existing translation, with the batch answering the job's questions (its languages, confirm the align preview), feeding one progress notice across the batch, and collecting what each job says. Cancel aborts the running note's job as Cancel always does (units in flight keep their markers) and leaves the rest unstarted; a job-fatal error does the same. Running the command again re-plans: finished notes are done, interrupted ones resume from their markers. At the end, a modal lists one line per note: its job's summary, or why it did nothing.

---

## 8. Writing safely

### 8.1 Three write classes (ADR 0009)

| Class | Used for | Guarantee |
|---|---|---|
| `insert` | ids, markers, frontmatter-free additions | Removing the inserted ranges from the result gives the original text exactly; checked before returning from `vault.process`. |
| `rewriteOwned` | replacing a marker with a translation, a marker with a map, a map with a map or marker | Every replaced range is exactly one whole Menard line (`isMenardLine`, and a `menard` block of `parseNote`, so never one in code or a user's `%%` block). User text is never touched. |
| `replace` | split; re-translate | Requires a `BackupToken` whose content hash equals the current text; every `expect` must equal the current slice. |

### 8.2 SafeWriter

Each method runs inside `vault.process(file, text => …)`, calls the job's compute function on the *current* text, verifies the class guarantee, and returns the original text unchanged (recording `write-conflict` or a violation) when anything fails. A per-path promise chain serializes Menard's own writes to one file. The file's EOL is preserved and inserted text is normalized to it. `create` refuses to overwrite. `setFrontmatter` uses `processFrontMatter` and sets only the given keys. `trashCreated` uses `fileManager.trashFile`.

### 8.3 Backups

`vault/backup.ts` copies the full current content to `<configDir>/plugins/menard/backups/<yyyymmdd-hhmmss>-<basename>.md` through the vault adapter, keeps the newest `backupCount` (default 30) across all notes but never prunes one of a note's own newest three (`BACKUPS_KEPT_PER_NOTE`, capped at `backupCount`; notes are told apart by basename), so re-translating other notes cannot remove the only backup of a note, and mints the `BackupToken`. Only this module can create one; the brand in `types.ts` makes it impossible to fabricate in typed code. Backups are plugin files, not alignment data, so they do not conflict with ADR 0001.

---

## 9. Reading

Both views use Obsidian's own `MarkdownView` leaves in reading mode (ADR 0007), so links, embeds, hover previews, footnotes and the reading/editing toggle keep working. One post-processor serves the facing and stacked views.

### 9.1 Post-processor

Registered with sort order 100. For each `(el, ctx)`:

1. Return unless `ctx.frontmatter` has `source` or `translation` (one property check for ordinary notes).
2. Return when `ctx.getSectionInfo(el)` is null (hover popover, embed, print, offscreen render) or the element is inside an `[data-menard-offscreen]` container.
3. `await pairs.load(file)`; return if not a pair.
4. If the section's lines are a Menard line, set `data-menard-line` (CSS hides it, spike S2) and return.
5. Find the unit with `model.unitAtLine(side, info.lineStart)`. Mark the unit element with `data-menard-unit`. Each block of a merged unit (ADR 0010) is a section of its own; each is marked with the unit's key, so a whole-unit highlight, scroll sync and the reader's queries find all of them.
6. If the unit has a map: project the element, take the words, reconcile this side (for a block of a merged side, that block's share of each link: `align/merge.ts#blockShare`), compute character ranges, and wrap each link in `span.menard-s[data-menard-link="p12.3"]`. Splitting text nodes with `splitText` only; a link crossing `<em>` or `<a>` becomes several spans with the same attribute; elements are never moved, rebuilt, or created through `innerHTML`. A footnote ref directly after a link's last fragment gets the same attribute. Links whose other side is empty get `menard-flagged`; approximate links `menard-approx`; loose links `menard-loose`. Set `data-menard-fit`.
7. Mark the section done for this model version, add a `MarkdownRenderChild` through `ctx.addChild`, and call `listener.sectionRendered(path, el)`.

### 9.2 Sessions and the reading cursor

`reader/sessions.ts#SessionManager` keeps one `PairSession` per pair whenever any leaf shows either note in reading view, created and disposed from `layout-change`, `active-leaf-change` and `file-open`. Sessions hold paths and look leaves up on demand; they never store view references. The mode is derived: **stacked** when the source leaf carries the stacked flag, else **facing** when both notes are visible in reading view in the same window, else **single**.

State drives the DOM. A session's state is `{cursor, hover, revealed}`. Every change runs one paint that toggles classes on the affected link attributes in the session's leaves only; when the post-processor reports a new section, the session repaints that section, so a sentence that virtualization removed and restored comes back highlighted.

Stepping (`reader/cursor.ts`, pure) walks `model.stops()`: by link (`j`, `→`) or by unit (`J`, `Shift+→`). If the target stop is not rendered, the pane scrolls to the unit's line with `previewMode.applyScroll(line)` and waits for the span with a `MutationObserver` (one-second timeout); on timeout it keeps the coarse position and the paint happens when the section arrives. If the cursor is off screen when a step key arrives (the reader scrolled freely), the step lands on the first stop at the reading line (35% of the viewport) instead. Clicking a sentence jumps the cursor there when it is a single click, the selection is collapsed, and the target is not a link, button or footnote ref. `Esc` clears the cursor. The last stop per source note is kept in plugin data (`readingPositions`, an LRU of 200 notes, written two seconds after the cursor settles and on unload; never in the notes). When a pair opens again in reading view, facing or stacked, the cursor returns to that stop and is scrolled into view; a stop that no longer resolves is ignored.

The current link gets `menard-current` and `aria-current`; its partner in the other pane gets `menard-partner`. A whole-unit stop, or a link whose spans are missing (degraded unit), highlights the unit element instead.

### 9.3 Facing view and held level

Open facing view works from either note: the source goes left in the current leaf, the translation right, via `workspace.getLeaf('split', 'vertical')` and `leaf.openFile(file, {state: {mode: 'preview'}, active: false})`, reusing a leaf that already shows the partner. Leaves get `data-menard-role` and `menard-facing`; unload removes the attributes and never detaches leaves.

Held level: after a cursor change, one animation frame reads the current fragment's top and the partner's top, then writes once. If the current sentence lies outside the comfort band (22% to 62% of the viewport), its own pane scrolls it to the reading line. The partner pane's `scrollTop` is then set so the partner's first fragment sits at the same height. Scrolling is smooth for moves within 1.5 viewports and instant otherwise, for key repeats, and whenever `prefers-reduced-motion` is set. A pane in editing mode pauses the session for that pane.

### 9.4 Scroll sync

Always on in facing mode. The driver is the pane that last received wheel, touch, pointer or scrolling-key input, for 150 ms after it. On a driver scroll (passive, coalesced to one frame): find the unit element at the reading line (`elementFromPoint`, then `closest('[data-menard-unit]')`), compute the fraction through the unit (across all its elements, for a merged unit), and place the partner unit so the same fraction sits at the reading line. Between paired units, interpolate from the bottom of the partner above to the top of the partner below; through unpaired regions (a bibliography) the follower parks. If the partner is not rendered, `applyScroll` to its line from `model.anchors()` and correct in pixels on the next frame. Programmatic scrolls record the expected `scrollTop` and ignore the echo. Scrolling never moves the cursor.

### 9.5 Stacked view and reveal

A mode of the source leaf. The translation of the current link appears directly beneath it in one `span.menard-gloss` (block display, `role="note"`, the target `lang`), inserted after the link's last fragment. Content comes from `render/gloss.ts`: the target unit's Markdown (every translation block of a merged unit, in order) is rendered offscreen into a detached `[data-menard-offscreen]` container with its own `MarkdownRenderChild` (never the plugin), wrapped with the target side's ranges, and the link's fragments cloned into the gloss. Links inside the clone open through `workspace.openLinkText`. Rendered units are kept in an LRU of 32, invalidated by model version.

Anchor-preserving reflow: before moving the gloss, read the current fragment's top; after, read it again and adjust `scrollTop` by the difference. Text the eye is on does not move; only text below the gloss shifts.

Reveal mode (setting, default off, toggled by command): the gloss starts concealed as a thin rule with `aria-label` "Translation hidden"; Space or Reveal translation shows it; any cursor move conceals again. Hover never reveals in this mode.

### 9.6 Live Preview

`render/live-preview.ts` provides one CodeMirror `StateField` of replace decorations, registered through a mutable extension array so a settings change can swap it and call `workspace.updateOptions()`. It acts only when `editorLivePreviewField` is true and the file from `editorInfoField` may be a pair note. On lines that no selection touches, outside fenced code, it hides trailing Menard ids (`/\s\^p\d+$/`), own-line Menard ids, and whole Menard lines (block replacement). It never hides a user's own id or comment. A block replacement must come from a state field, which is why this is not a view plugin.

### 9.7 Keys

A capture-phase `keydown` listener on each window's document (popouts through `workspace.on('window-open')`), registered with `registerDomEvent`. It acts only when reading keys are on, the active leaf belongs to a session and is in reading view, focus is not in an input, textarea, select, contenteditable, modal or menu, no Ctrl/Meta/Alt is held, and the event is not composing.

| Key | Action |
|---|---|
| `j`, `→` | next link |
| `k`, `←` | previous link |
| `J`, `Shift+→` | next unit |
| `K`, `Shift+←` | previous unit |
| `Space` | reveal (stacked view with reveal mode only; otherwise not handled) |
| `Esc` | clear cursor (only when there is one) |

Handled keys call `preventDefault` and `stopPropagation`; others pass through. Every action is also a command with no default hotkey.

### 9.8 Hover

Delegated pointer events with a 120 ms dwell, mouse only. In facing mode the partner gets `menard-hover`; nothing scrolls. In stacked mode (reveal mode off) a floating `menard-ghost` card shows the partner beneath the hovered line without reflowing text. Hover never moves the cursor.

### 9.9 Styling and accessibility

All styling is in `styles.css` through Menard variables derived from Obsidian's (`--text-highlight-bg`, `--interactive-accent`, `--text-muted`, `--text-warning`, `--background-modifier-border`). Highlights change only background, decoration and outline, never metrics, so highlighting never reflows text; `box-decoration-break: clone` keeps multi-line sentences continuous. Current, partner and hover differ in shape (solid underline, none, dotted) as well as colour. Forced-colors mode uses outlines; reduced motion disables transitions. Unit elements get the side's `lang`. No inline styles, no injected style elements.

---

## 10. The claude CLI backend

### 10.1 Detection

`llm/detect.ts`: the `claudePath` setting if set and executable; else the first executable of `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (and `%USERPROFILE%\.local\bin\claude.exe` on Windows); else, only when the user presses Detect in settings, `$SHELL -lc 'command -v claude'` with a three-second timeout. Menard never installs or updates the CLI.

### 10.2 Invocation

`llm/claude-cli.ts`:

```
claude -p --output-format json --model <model> --safe-mode --strict-mcp-config --tools ""
       --no-session-persistence --max-turns 3 --system-prompt <system> --json-schema <schema>
```

The prompt goes on stdin. Never `--bare` (it disables OAuth and the keychain) and never `--setting-sources ""` as isolation (it does not isolate). `--safe-mode` is what keeps the user's CLAUDE.md, memory, hooks and connectors out of the call. The working directory is a fresh `os.tmpdir()/menard-*`, removed afterwards. The environment is `process.env` plus `HOME` and `USER` from `os.userInfo()` when missing; the keychain lookup needs `USER`. Timeout (default 180 s) and abort send SIGTERM, then SIGKILL after 3 s. stdout is capped at 4 MB and stderr at 64 KB. Every child is tracked and killed on unload.

`llm/envelope.ts` decides success by `is_error`, never by `subtype` (which says "success" on failure). Not logged in maps to `cli-not-logged-in`; usage and rate limits to `cli-rate-limited`; other errors to `cli-model-error`; non-JSON stdout to `cli-bad-envelope`; a non-zero exit with no JSON to `cli-crash`; spawn `ENOENT`/`EACCES` to `cli-not-found`. The payload is `structured_output`, falling back to `result` with a code fence stripped.

### 10.3 Prompts and protection

`llm/protect.ts` replaces verbatim tokens with placeholders before a prompt and restores them after: footnote refs as `⟦^3⟧` (restored with the same label, which is how numbering stays matched), inline comments `⟦C1⟧`, inline code, math, embeds and HTML `⟦V1⟧`, Markdown link URLs, the reference of a `[label][ref]` link and bare URLs `⟦U1⟧` (the label stays visible and is translated), whole reference definitions and collapsed `[ref][]` links `⟦V1⟧`, quote line breaks `⟦BR⟧` and blank quote lines `⟦P⟧`. Wikilinks stay in the text, so the model can read the name, and must come back unchanged. A source containing `⟦` or `⟧` is refused for that unit.

`llm/prompts.ts` builds five call kinds, each with a JSON schema:

- **Translate** (sentence units): numbered source sentences, the document title, the previous unit's source and translation as read-only context, and the user's extra instructions. Returns `{groups: [{src: int[], markdown: string}], calloutTitle?}`. One group per source sentence unless the translation fuses sentences; never reorder across groups; translate quotations and use target-language quotation marks; keep emphasis on the corresponding words; output no `%%`, block ids, heading or quote markers, or blank lines.
- **Align**: numbered sentences of both sides. Returns `{groups: [{src: int[], tgt: int[], loose: boolean}]}`. Never returns text.
- **Pairing**: the indexed units of one section on both sides, each with kind, word count and excerpt (§7.2). Returns `{groups: [{src: int[], tgt: int[]}]}`. Never returns text.
- **Plain** (lists, tables, footnotes): the protected block. Returns `{markdown}` with the same line structure.
- **Outline**: the headings in order. Returns `{headings: string[]}` of the same length.

Language names come from `Intl.DisplayNames`.

### 10.4 Validation and retry

`llm/validate.ts` checks everything before a write. Translate: the `src` arrays flatten to exactly 1…N with each group consecutive; at most one leading or trailing addition group with `src: []`; the placeholder multiset and the wikilink multiset equal the source's; no `%%`, blank line, trailing `^id`, or leading `#`, `>`, `-` or `|`; a target-to-source length ratio outside 0.4–2.5 only warns. Align: both sides covered exactly once, contiguous, monotone, no group empty on both sides. Pairing: the same, plus the merge rules of §7.2. Plain: placeholders and wikilinks kept, same line count, same list markers and table pipes per line. Outline: same count, no empty or multi-line heading.

A failed validation retries up to `maxRetries` (default 2) with the errors appended to the prompt ("Your previous answer was rejected: placeholder ⟦^3⟧ missing. Return corrected JSON."). Timeouts, crashes and model errors retry once. After that the unit fails, keeps its marker, and the job continues.

---

## 11. Errors

All cross-module errors are `MenardError` with a stable code (`src/errors.ts`). Notices are plain text with no stack traces; there is no `console.log`, and `console.error` (prefixed `Menard:`) is reserved for unexpected exceptions.

| Code | What the user sees |
|---|---|
| `cli-not-found` | "Claude Code was not found. Set its path in Menard's options." The job does not start. |
| `cli-not-logged-in` | "Claude Code is not signed in for apps started outside a terminal. Run `claude` once in a terminal and sign in, then try again." Job stops; progress kept. |
| `cli-rate-limited` | "Claude usage limit reached. 41 of 74 written; run Translate note later to resume." |
| `cli-timeout` | The unit retries once; the first-run notice mentions a possible keychain prompt. |
| `cli-crash`, `cli-bad-envelope`, `cli-model-error` | Retried once, then the unit fails and is listed in the summary. |
| `output-invalid` | Retried with feedback, then the unit fails. |
| `write-conflict` | Retried once on fresh text, then "The note changed while writing; run again." |
| `not-owned`, `insert-only-violation` | A bug: nothing is written, the job stops, and the notice asks for a report. |
| `split-refused`, `split-verification-failed` | A modal with the reason; nothing is written. |
| `pair-not-reciprocal` | "This note links to a translation that does not link back. Run Check alignment to repair." |
| `desktop-only` | "Translation needs the desktop app." |

---

## 12. Settings, commands, shared files

### 12.1 Settings

Declarative only (`getSettingDefinitions()`, `minAppVersion` 1.13.0, no `display()`), sentence case, headings without the word "settings". Defaults are in `src/settings.ts`.

| Group | Settings |
|---|---|
| Translation backend | `claudePath` (with Detect and Test connection actions), `model` (`sonnet`), `concurrency` (2, 1–4), `timeoutSeconds` (180), `maxRetries` (2, 0–3). The group description carries the disclosure. |
| Languages | `defaultSourceLanguage` (`es`), `defaultTargetLanguage` (`en`), `extraAbbreviations`, `splitDialogue` (off), `extraInstructions` |
| Notes | `textStartHeading` (empty), `skipHeadings`, `translationHeading` (English translation), `newNoteProperties` |
| Reading | `readingKeys` (on), `hoverPartner` (on), `revealMode` (off) |
| Editing | `hideBlockIds` (on), `hideSentenceMaps` (on) |
| Safety | `backupCount` (30) |

### 12.2 Commands

No default hotkeys. Ids never repeat the plugin id; names include neither "Menard" nor "command". Conditional commands use `checkCallback`. Re-translate and re-align take the unit from the editor cursor line when the active note is in editing mode, and from the reading cursor otherwise; one `checkCallback` covers both, so the commands also work in reading view, where editor commands are not offered.

| Id | Name | Available when |
|---|---|---|
| `translate-note` | Translate note | active note is not a translation note; no job running |
| `align-with-translation` | Align with existing translation | same |
| `split-combined-note` | Split into source and translation notes | the note has the boundary heading |
| `translate-folder` | Translate or align every note in this folder | an active note (its folder); no job running. Also on a folder's file menu (§7.7) |
| `retranslate-paragraph` | Re-translate paragraph | a unit under the reading or editor cursor |
| `realign-paragraph` | Re-align paragraph | same, sentence unit |
| `check-alignment` | Check alignment | active note is in a pair |
| `cancel-job` | Cancel translation job | a job is running |
| `check-claude` | Check Claude connection | always |
| `open-facing-view` | Open facing view | active note is in a pair |
| `toggle-stacked-view` | Toggle stacked view | active source note in reading view |
| `next-sentence`, `previous-sentence` | Next sentence, Previous sentence | an active session |
| `next-paragraph`, `previous-paragraph` | Next paragraph, Previous paragraph | an active session |
| `reveal-translation` | Reveal translation | stacked view in reveal mode |
| `toggle-reveal-mode` | Toggle hidden translation | stacked view |
| `clear-reading-cursor` | Clear reading cursor | a cursor exists |
| `copy-paragraph-link` | Copy link to current paragraph | a cursor exists; copies `[[basename#^p12]]` |
| `import-epub` | Import EPUB as chapter notes | always (§16.1) |
| `add-pdf-page-markers` | Add print page markers from PDF… | active note is Markdown (§16.2) |
| `import-pdf-text` | Import PDF text as a note | always (§16.3) |
| `report-problem` | Report a problem | always; read-only diagnostic of the active pair (`src/diagnose/`), shown in a modal to copy or save as `menard-report-<date>.md`. No note text beyond opt-in 40-character snippets |

### 12.3 Shared files and change control

`src/types.ts`, `src/constants.ts`, `src/errors.ts` and `src/settings.ts` are the contract. Modules consume them and never edit them in passing; a module that needs a change stops and asks for it, and the change lands for every module at once. `test/__mocks__/obsidian.ts` is complete for every runtime export Menard uses; module-specific fakes (an in-memory vault, a fake `App`, a fake backend) live in that module's own test folder. No module adds a dependency; `package.json` belongs to the integration module.

---

## 13. Testing

Tooling: vitest (node environment by default; `// @vitest-environment happy-dom` per DOM test file), `tsc --noEmit` in strict mode, `eslint` with `eslint-plugin-obsidianmd` recommended plus the purity rule, and the production build, all in CI on every push.

Pure modules carry most of the coverage: table-driven tests, the known-answer vectors of §4.3, round trips (parse ∘ serialize; protect ∘ restore; split plan reconstruction), and invariants (insert-only verification; maps whose totals equal the projection's word count by construction). DOM modules are tested in happy-dom on hand-built reading-view markup. The CLI runner is tested against a fake `claude` written to a temp dir at test time, driven by environment variables to emit canned envelopes, hang, exit non-zero, ignore SIGTERM, or record its argv, stdin and cwd. Jobs are tested end to end with an in-memory vault and a fake backend: translate, cancel and resume; a failed unit keeping its marker; out-of-order completion giving identical text; align changing no word.

**Projection parity** is the one cross-module test that matters most: for every fixture unit, the words of `projectMarkdown(body)` equal the words of `projectElement` over that unit's reading-view DOM. The DOM samples are recorded once from Obsidian 1.13.7 reading view and refreshed by hand when Obsidian changes its markup.

**Fixtures.** Committed fixtures are synthetic Spanish and English academic prose written for the project, plus public-domain text (*Don Quijote* with Ormsby), reproducing every structural feature of the vault's four combined notes: H1 and H2 boundaries, `[^en-n]` and `[^gen-n]` labels, a provenance callout, an affiliation line glued to a heading, a three-line epigraph with an attribution, inline `%%p. n%%` markers, a standalone date line, hard-wrapped paragraphs, multi-line verse quotes, a footnote with indented continuation and a nested quote, a bare `---` before footnotes, and the English-only refusal case. The real notes (Borges is under copyright; Ruiz is CC BY-NC-ND) are never committed: `test/fixtures/private/` is gitignored, and tests that use it are `describe.skipIf` when it is absent.

---

## 14. Verification spikes

Each [VERIFY] item from the research is isolated behind one constant or one small function, so a failed check is a local change. They are checked in a dev vault holding copies of the test notes, before the views are considered done.

| Spike | Question | Isolated in |
|---|---|---|
| S1 | `previewMode.getScroll`/`applyScroll` use source lines; direct `scrollTop` writes stick; how many sections stay rendered; p95 step-to-level under 150 ms across all of @ruizalmotasim. If this fails, the facing view falls back to a read-only `ItemView` rendering with `MarkdownRenderer`, reusing the post-processor, wrap and session code (ADR 0007). | `reader/facing.ts`, `reader/scroll-sync.ts` |
| S2 | Does a section holding only a `%%…%%` line render an empty element with margin? Are comment contents indexed by search? | `constants.ts#ATTR.menardSection`, `styles.css` |
| S3 | Footnote ref and definition markup and class names; how the footnote section reaches the post-processor; callout title and embed selectors. | `render/dom-projection.ts` skip list |
| S4 | Does a capture-phase document listener see arrow keys before reading view scrolls, and does `preventDefault` stop it? | `reader/keys.ts` |
| S5 | Are block replace decorations over Menard lines stable while typing nearby, and do hidden trailing ids disturb cursor motion? | `render/live-preview.ts` |
| S6 | Does the first spawn from Obsidian trigger a keychain prompt, and does it block until answered? | `llm/claude-cli.ts`, the first-run notice |
| S7 | Does Obsidian parse a trailing id placed after an inline comment (`… %%p. 2%% ^p1`)? If not, such paragraphs get an own-line id. | `text/ids.ts` |
| S8 | Does `processFrontMatter` keep the vault's preamble values (quoted wikilink lists, `course` lists) intact? | `vault/writer.ts` |
| S9 | Display text of `[[a#h]]` and `[[a#^id]]` in reading view. | `text/inline.ts`, parity fixtures |

---

## 15. Implementation modules

Seven modules work concurrently in one tree, each owning a disjoint set of files; integration runs last. The briefs handed to implementers repeat this table with responsibilities, tests and acceptance criteria.

| Module | Owns | Depends on |
|---|---|---|
| text | `src/text/*`, `test/text/*`, `test/fixtures/*` (synthetic, committed) | — |
| align | `src/align/*`, `test/align/*` | — (types only) |
| llm | `src/llm/*`, `test/llm/*` | — |
| vault | `src/vault/*`, `test/vault/*` | text, align |
| render | `src/render/*`, `test/render/*` | align (text for parity tests) |
| reader | `src/reader/*`, `test/reader/*` | align (types), render (attribute contract) |
| jobs | `src/jobs/*`, `test/jobs/*` | text, align, llm, vault |
| import | `src/import/*`, `test/import/*` (synthetic fixtures only), `tools/*` | text (edits), vault (writer) |
| integration | `src/main.ts`, `src/settings-tab.ts`, `styles.css`, `README.md`, `manifest.json`, `versions.json`, `package.json`, `test/main.test.ts`, `test/settings-tab.test.ts`, `test/__mocks__/obsidian.ts` | all |

---

## 16. Import

Four commands bring books into the vault as source notes or pairs. They read files on the device and write through `SafeWriter`; nothing leaves the machine and no dependency is added. The pure parts (`zip`, `epub`, `pdf`, `pages`) take bytes, a DOM parser and plain pdf.js items, so they run under vitest and in a headless harness; `commands.ts` holds the modals and the Obsidian calls. Files come from a native file input (desktop and mobile), a vault path, or, on desktop only, an absolute path read with Node `fs` behind `Platform.isDesktopApp`. Test fixtures are synthetic: the repository is public and the books used for acceptance are copyrighted.

### 16.1 EPUB as chapter notes

- **Zip.** `zip.ts` reads the central directory and inflates deflated entries with `DecompressionStream("deflate-raw")`. No ZIP64 or encryption.
- **Package.** `container.xml` → OPF → manifest, spine (XHTML items in order) and metadata (`dc:title`, first `dc:creator`, the year of `dc:date`, `dc:language`, `dc:publisher`). XHTML is parsed as XML so self-closing `<span/>` and `<a/>` stay empty; a document that is not well-formed (HTML entities) is re-parsed as HTML.
- **Chapters.** The TOC is the EPUB 3 nav (`epub:type="toc"`) or the NCX `navMap`; when it has a single top-level entry, its children are used. Each top-level entry starts a chapter at its file; a spine file without an entry joins the chapter before it, so a file holding several sections stays one note and continuation files are not split off. A file with fewer than 60 words, or a copyright page under 300 words, that starts no chapter is skipped and reported (cover, title, epigraph, emptied notes file). A file before the first TOC chapter with enough text becomes its own note, titled by its first heading or short first paragraph. Notes are numbered `NN` in spine order from 01.
- **Footnotes.** A link is a note reference when it is typed (`epub:type="noteref"`, `role="doc-noteref"`), when its target is a typed note container (`footnote`, `endnote`, `aside`, `doc-footnote`), or when the target block opens with the target and links back to the reference (calibre and InDesign `…-backlink` anchors). The definition is the target's block, grown while its parent holds no other link target. References become `[^n]`, numbered per chapter in reading order (a repeated reference reuses its number); definitions, from any spine file, are appended to the chapter that cites them, with their backlinks removed.
- **Pages.** `epub:type="pagebreak"` and `role="doc-pagebreak"` elements and page-list targets become `%%p. N%%` (N from `title`, `aria-label` or text), inline where they stood; a marker alone between blocks opens the next paragraph, or stands on its own line before a heading. A chapter with markers gets `pageSource: epub-pagelist`.
- **Markdown.** Classes the book's CSS styles italic or bold (and class names like `Italic`, `Bold`) become `em` and `strong`; images and in-book links are dropped, external links kept; each chapter's nodes are imported into an HTML document and converted with Obsidian's `htmlToMarkdown`. Quotes and dashes pass through untouched.
- **Notes.** `@citekey/NN Title.md` with `originalLanguage`, `book: "[[@citekey]]"`, `chapter`, `sourceEdition` ("Publisher, year (EPUB)"). No pair links: Translate and Align add those. The citekey is suggested Better BibTeX style: creator surname, first title word that is not an article or preposition, year, lowercase ASCII. The hub `@citekey.md` is written only when absent; otherwise its links are shown to paste. If any chapter note exists the import refuses before writing.

### 16.2 Print page markers from a PDF

For a chapter note, or every note in its folder in name order, `pages.ts` places one marker per PDF page:

1. Each page's lines (see §16.3) lose running heads, folios and display titles; the first 60 letters of the rest are the page's *opening*.
2. Note and openings are reduced to bare lowercase letters: accents and ligatures decomposed and dropped, digits, punctuation and **all whitespace removed**, which absorbs OCR that splits words (`u n a`, `abiertam ente`). Frontmatter, `%%…%%` comments, footnote references and definitions, block ids and link targets are left out of the note's letters.
3. The opening is located by character trigrams counted only near their own position (±3 letters of OCR drift), then the start is pinned to where the first dozen trigrams match exactly, since drift accumulates toward the tail, searching forward from the last page placed, at most about five pages ahead, and never past an existing marker with a higher number. Below 60 % of trigrams found, the page is skipped and reported.
4. The marker goes at the nearer word boundary (a page that starts mid-word gets it before or after that word), or on its own line before a heading. Pages whose label already has a marker are skipped; existing markers never move. The write is `insert`-class (ADR 0009), computed on the current text inside `vault.process`.
5. N is the PDF's page label when it has labels, else the PDF page number plus the offset given in the modal. A note that received markers gets `pageSource: pdf-matched` and `pageSourceFile`.

Across a folder, each note sees only the pages after the last one placed in the note before it.

### 16.3 PDF text as a note

`pdf.ts` reads pdf.js text items (Obsidian's bundled copy through `loadPdfJs()`) for a page range:

- Items on one baseline (within half a font size) form a line; a gap wider than 0.15 em adds a space.
- Running heads and folios: up to two lines at the top and bottom of each page that are short and are a bare number or roman numeral, recur at the top (or bottom) of another page in the range, or, at the top only, are a short text with a number at one end. A numbered line at the bottom is kept, since it may be a footnote; display type (1.4 times the page's body size or more) is never furniture.
- Each page is measured on its own (scans drift in size and margin from page to page): body size and leading are medians, the left margin is the leftmost x three lines share, the right edge is where lines starting at that margin end. Each line is then labelled:
  - *Title.* Display type at the top of a page is the chapter's `#` heading; a bare number before the title becomes `# N. Title`. The page's marker goes in the text after it.
  - *Heading.* One or two lines that do not span the measure and do not end in `.`, `,` or `;`, with space above and below (over 1.4 times the leading for slightly larger type, over 1.8 for body type starting with a capital), become one `##` heading; a heading split over two lines is joined.
  - *Note.* Small type (under 0.9 of body) only when it is a run at the foot of the page below a gap; these are gathered under `## Notes` with their page's marker. Small type anywhere else is text.
  - *Quotation.* A run of lines inset at both margins (by 0.8 em or more), at least two lines or in smaller type, is a block quotation: its lines are joined and dehyphenated into one `> ` paragraph, continuing across a page break, and a new one starts at a wide gap or a further-indented line after a closing line.
  - *Epigraph.* Such a run before any body text or heading is an epigraph and stays plain paragraphs, split where the x position moves (the attribution).
- A paragraph starts at a first-line indent, a vertical gap over 1.6 times the page's leading, or after a short line ending in closing punctuation. Lines are joined with spaces; a line ending in a hyphen before a lowercase letter is joined without it.
- A `%%p. N%%` marker opens each page's text inline; when a page starts inside a hyphenated word, the marker follows that word; a page that opens on a `##` heading gets the marker on its own line before it.

The heuristics come from two scanned books and fail on two-column layouts and verse; section headings come from layout alone, not the PDF outline. `tools/pdf_paragraphs.py` is the same cleanup for `pdftotext` output, for use from a shell.

### 16.4 A pair from PDF pages

"Import a chapter pair from PDF…" takes a source (a PDF page range, or the open note, typically a chapter note from EPUB) and optionally a translation (another PDF page range), each with its own offset, plus a name, folder and the two languages. Both PDFs are read and converted (§16.3) and every target path is checked before anything is written. The source note gets `originalLanguage`, `sourceEdition` ("PDF name, pp. 112–129") and `pageSource: pdf-text`; the translation note, at `translationPath` (`NN Title (EN).md`), gets `source:`, `sourceLanguage`, `targetLanguage` and its own `sourceEdition`, and the source gets `translation:`. A modal then offers Align (with a translation) or Translate (without), started through the job controller, whose own preview and confirmation follow. An open note that already has `translation:` is refused.
