# Menard

Read a text against its translation, aligned sentence by sentence, and translate or align pairs with Claude Code.

Menard keeps the original as the page you read and makes the translation an aid you call up when you need it. A source note and its translation note form a *pair*. Menard aligns them paragraph by paragraph and sentence by sentence, and stores that alignment in the Markdown itself, so it syncs with your vault and survives uninstalling the plugin.

Named after Borges's "Pierre Menard, autor del *Quijote*".

> Status: early development. Not yet in the community directory. Desktop only.

## Privacy and network use

- **What is sent, and where.** Translating and aligning run the [Claude Code](https://docs.claude.com/en/docs/claude-code) command-line tool (`claude`) on your computer, as a local child process. The text of the note you translate or align is sent to Anthropic by that tool, under your own Claude account. Menard itself opens no network connections.
- **Account.** Translating and aligning need a Claude account with a plan that includes Claude Code. Reading a pair that already exists needs neither the CLI nor an account.
- **An executable outside the vault.** Menard runs `claude` from the path in its options, or looks for it in the usual install locations (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`). The Detect button also asks your login shell. Menard never installs or updates the CLI.
- **Isolation.** Each call runs in a fresh temporary folder with `--safe-mode`, no tools and no session history, so your Claude Code memory, hooks and connectors are not used.
- **No telemetry.** Menard collects nothing and reports nothing.
- **Importing stays local.** Importing an EPUB or a PDF, and adding page markers from a PDF, read the file on your device and write notes into the vault. Nothing is sent anywhere, and no account or CLI is needed.
- **Backups.** Before Menard replaces any text you wrote (splitting a note, re-translating an edited paragraph), it saves a full copy of the note in the plugin folder, `<config folder>/plugins/menard/backups/`. The newest 30 are kept by default.

## What it does

- **Translate note** creates a translation note beside the source and translates it paragraph by paragraph. Each paragraph's translation comes with its sentence alignment, so nothing has to be guessed afterwards.
- **Align with existing translation** pairs a note with a translation you already have, without changing a word of either.
- **Split into source and translation notes** turns one note that holds both texts (a text section followed by an "English translation" section) into a pair.
- **Facing view** shows the two notes side by side, scroll-synced by paragraph.
- **Stacked view** shows only the original, with the translation of the current sentence directly beneath it. Optionally the translation stays hidden until you reveal it.
- **Import** an EPUB as one note per chapter, with footnotes and print page markers, or the text of a PDF page range as a note, or a chapter and its translation from PDF page ranges as a pair; add print page markers to a chapter from a scanned PDF.
- **Reading cursor**: step sentence by sentence with the keyboard or click a sentence; its partner is highlighted and held level in the other pane. Hovering shows a partner without moving the cursor. Optionally every other sentence fades so the current pair stands out.

### Screenshots

To be added before submission:

1. Facing view with the current sentence and its partner highlighted.
2. Stacked view with a translation under the current sentence.
3. Stacked view in hidden-translation mode.
4. The Translate note preflight and progress notice.
5. A GIF of stepping through sentences with `j` and `k`.

## Install

Menard is not in the community directory yet. To try it, copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/menard/`, reload Obsidian, and enable Menard under Community plugins. It needs Obsidian 1.13 or later, on desktop.

For translating and aligning, install Claude Code and sign in once in a terminal (`claude`). Then open Menard's options and press **Test connection**. If Claude Code is not found, press **Detect** or enter its absolute path.

## Usage

Every action is a command in the command palette. None has a default hotkey; assign your own under Hotkeys.

| Command | What it does |
|---|---|
| Translate note | Opens a preflight with the languages (taken from an `originalLanguage`, `language` or `lang` property when the note has one, and checked against the text), model, number of paragraphs, where the text starts and estimated time. On confirm, adds paragraph ids to the source, creates `<name> (EN).md` beside it, and translates paragraph by paragraph with progress in a notice and the status bar. Cancel stops it; running the command again resumes where it stopped. |
| Align with existing translation | Picks the translation note (from the `translation` property or a note picker), shows how the paragraphs pair up, and on confirm adds ids and sentence maps. The text of both notes stays as it is. Spans with no counterpart are flagged, not forced. |
| Translate or align every note in this folder | From a note, or a folder's right-click menu: runs Translate note, or Align with existing translation when a note already has a translation (linked, or a same-named `(EN)` note beside it), for each note of the folder in name order. One preflight lists every note with what will happen and a rough number of Claude calls; one notice shows progress for the whole batch; finished notes are skipped. Cancel stops it; running it again resumes. A summary lists the outcome per note. |
| Split into source and translation notes | For a note with a translation heading (default "English translation"): moves that section into a new translation note, renames footnotes such as `[^en-3]` to match the source, saves a backup, then aligns. It first confirms the languages of both halves, checked against their text. |
| Re-translate paragraph | Translates the paragraph under the reading cursor, or under the editor cursor, again. Asks first if you edited the translation; a backup is saved. |
| Re-align paragraph | Rebuilds the sentence map of one paragraph. |
| Check alignment | Reports unpaired paragraphs, unfinished work, maps that no longer fit edited text, and a one-sided pair link, with actions to refresh maps, realign, repair the link or resume. |
| Cancel translation job | Stops the running job. Finished paragraphs are kept. |
| Check Claude connection | Sends a one-line request and reports the path, model and response time. |
| Open facing view | Opens the pair side by side, source on the left. Works from either note. |
| Toggle stacked view | Turns stacked view on or off for the source note in reading view. |
| Next sentence, Previous sentence | Moves the reading cursor by one sentence. |
| Next paragraph, Previous paragraph | Moves the reading cursor by one paragraph. |
| Reveal translation | Shows the hidden translation in stacked view. |
| Toggle hidden translation | Switches stacked view between showing and hiding the translation until revealed. |
| Clear reading cursor | Removes the cursor and its highlights. |
| Copy link to current paragraph | Copies a link such as `[[@note#^p12]]` to the paragraph under the cursor. |
| Import EPUB as chapter notes | Reads an `.epub` (chosen with a file picker, a vault path, or on desktop an absolute path) and asks for a citekey (suggested from author, title and year, Better BibTeX style), the source language and a folder. Writes `@citekey/NN Title.md`, one note per top-level table-of-contents entry (files between two entries belong to the earlier one), with `originalLanguage`, `book`, `chapter` and `sourceEdition` properties, footnotes as `[^n]`, and `%%p. N%%` markers when the EPUB has a page list or page breaks. Writes a hub note `@citekey.md` with links to the chapters unless one exists; then it lists the links to paste instead. Short cover, title and copyright files are skipped and reported. Refuses, writing nothing, if a chapter note already exists. |
| Add print page markers from PDF… | For the active note, or every note in its folder: finds where each PDF page starts in the text, through bad OCR, and inserts `%%p. N%%` there. N is the PDF's page label, or the PDF page plus an offset you give. Only inserts; existing markers are left where they are; pages it cannot place confidently are reported. Sets `pageSource: pdf-matched` and `pageSourceFile`. |
| Import a chapter pair from PDF… | The source from a PDF page range, or the open note (say, a chapter imported from EPUB); the translation, optionally, from another PDF page range, each with its own page offset. Writes `NN Title.md` and `NN Title (EN).md` (suffix from the target language) linked as a pair, with `sourceLanguage`, `targetLanguage` and `sourceEdition` (PDF name and printed pages), then offers to run Align, or Translate when no translation PDF was given. |
| Import PDF text as a note | Turns a page range of a PDF's text layer into paragraphs: running heads and page numbers dropped, lines rejoined and dehyphenated, the chapter's number and title as `#`, set-off section titles as `##`, inset block quotations as `> ` (also across a page break), epigraphs kept as paragraphs, only foot-of-page small type gathered as notes at the end, a `%%p. N%%` marker where each page starts. Scanned PDFs need an OCR text layer. A shell version is in [tools/](tools/README.md). |
| Report a problem | Collects a diagnostic report for the active pair, to copy or save. See [Troubleshooting](#troubleshooting). |

### Reading keys

In reading view, while a pair is open (turn off under Reading in the options):

| Key | Action |
|---|---|
| `j` or `→` | next sentence |
| `k` or `←` | previous sentence |
| `J` or `Shift+→` | next paragraph |
| `K` or `Shift+←` | previous paragraph |
| `Space` | reveal the translation (stacked view, hidden-translation mode) |
| `Esc` | clear the cursor |

A click on a sentence moves the cursor there. Keys do nothing while you type in a field, a modal or the editor.

### Options

- **Translation backend**: the Claude Code path (with Detect and Test connection), model, parallel requests, timeout and retries.
- **Languages**: default source and target languages, extra abbreviations, dialogue splitting, extra instructions for every translation.
- **Notes**: the heading where the text starts, sections never translated (bibliographies by default), the translation heading used by Split, and properties added to new translation notes. With the start heading left empty, the text starts after a heading named `Text` when the note has one; otherwise Menard leaves out the leading lines that hold only links, embeds, URLs or `BUTTON[…]` code, and starts at the first block with prose, a heading, a quote or a callout. Notes whose metadata contains prose (a citation, class notes) should use a start heading. Translate note shows the first text unit so you can check where the text starts.
- **Reading**: reading keys, hover, hidden translation in stacked view, fading other sentences (and how faded).
- **Editing**: hide paragraph ids and sentence maps in live preview.
- **Safety**: how many backups to keep.

## Troubleshooting

If highlights land on the wrong sentence, the facing view drifts out of level, or a paragraph is never highlighted, open the pair (ideally in facing view, in reading view, scrolled to where it goes wrong) and run **Report a problem** from the command palette. It shows a report you can **Copy** or **Save to vault** (as `menard-report-<date>.md` at the vault root) and attach to an issue.

The report contains the plugin and Obsidian versions, your platform, your options (the Claude Code path cut to its file name; extra instructions and note properties reduced to their length), the pair's unit, pairing and sentence-map counts with how well each map still fits the text, which units the reading view tagged and how, the line ranges and heights Obsidian holds for each rendered section (negative or absurd heights are flagged), and the reading cursor's position. It contains no note text unless you turn on **Include text snippets**, which adds at most the first 40 characters of each paragraph and section. Collecting the report changes nothing and does not scroll. Read it before you share it: file paths and note names are included.

Running **Check alignment** first is often enough: it lists maps that no longer fit edited text and offers to refresh or realign them.

## On-disk format

Everything Menard knows about a pair is in the two notes; plugin data holds only your options. The source note links to its translation with `translation: "[[<name> (EN)]]"`, and the translation note links back with `source:` and records `sourceLanguage` and `targetLanguage`. Corresponding paragraphs carry the same block id (` ^p12`), and each translated paragraph is followed by one hidden line such as `%%menard:1 p12 33.myfp/46.6ton 33.7teg/35.ny2r%%`, which records the word counts and short word hashes of each sentence pair. Unfinished work is recorded as `%%menard:1 p13 translate%%`.

If you uninstall Menard, both notes remain ordinary Markdown: ids are standard Obsidian block ids, and Menard lines are Obsidian comments that reading view does not show. The full grammar is in [docs/DESIGN.md §4](docs/DESIGN.md#4-on-disk-format).

## Roadmap

Planned after v1, each tracked in an issue:

- Bring-your-own-key providers: [Anthropic API](https://github.com/zackmezera/menard/issues/15) and [OpenAI-compatible endpoints](https://github.com/zackmezera/menard/issues/16).
- [Mobile support](https://github.com/zackmezera/menard/issues/17), with stacked view as the phone layout.
- [Vocabulary capture](https://github.com/zackmezera/menard/issues/18) and [export to Anki or TSV](https://github.com/zackmezera/menard/issues/19).
- [PDF ingestion](https://github.com/zackmezera/menard/issues/20): text import, page markers and importing a chapter pair from PDF are in.
- [Reveal-rate statistics](https://github.com/zackmezera/menard/issues/21).
- [DeepL](https://github.com/zackmezera/menard/issues/22) was considered and rejected, because it cannot return sentence-aligned output.

## Development

```sh
npm install
npm run dev        # watch build to main.js
npm run build      # typecheck + production build
npm test           # unit tests (vitest)
npm run lint       # eslint with eslint-plugin-obsidianmd
npm run typecheck
npm run field      # private regression check against real claude (see below); not part of npm test
```

### Private regression check for adaptations

Free and adapted translations are the hard case for Align, and the texts that show it are copyrighted, so they never enter this repository. They live in `fixtures-private/` (gitignored), one folder per pair:

```
fixtures-private/<name>/source.md        # the source note, pristine: no Menard ids or lines
fixtures-private/<name>/translation.md   # the translation note, pristine, with sourceLanguage/targetLanguage
fixtures-private/<name>/expected.json    # the expected paragraph pairing
```

`expected.json` lists one entry per paired unit, each side giving the first words of its paragraphs in order, so a merged unit has two or more on one side: `{"settings": {"textStartHeading": "Text"}, "pairs": [{"source": ["Detenerse en lo", "La superstición del"], "target": ["To undo the"]}]}`. `settings` (optional) overrides Menard's defaults for that pair.

Warning: `git worktree remove` deletes a worktree's untracked and ignored files, so `fixtures-private/` inside a worktree is lost with it; keep the fixtures in the main checkout or copy them out first.

`npm run field` runs the real Align, paragraph pairing and sentence pass, through the real `claude` CLI (`MENARD_CLAUDE`, else `~/.local/bin/claude`) on every such folder, and prints expected against actual pairing, flagged and loose links, and text drift; it fails on drift or a missing expected pair. Each run writes `last-run.txt` and the aligned notes (`out-*.md`) into the fixture's folder. From a worktree, point it at the main checkout's fixtures instead of copying them: `MENARD_FIELD_FIXTURES=/abs/path/fixtures-private`, and `MENARD_FIELD_OUT=/some/scratch` to write the outputs there rather than beside the fixtures. It spends Claude calls, so it is never part of `npm test` or CI. To make a fixture from an aligned pair, strip Menard's ids and lines (`test/field/strip.ts`) and record the pairing you expect.

Domain vocabulary is defined in [CONTEXT.md](CONTEXT.md), the design in [docs/DESIGN.md](docs/DESIGN.md), and decisions in [docs/adr](docs/adr/README.md). The manual checks done in a development vault before a release are in [docs/QA.md](docs/QA.md).

Menard is a clean-room implementation, written from scratch without code from other plugins. Please do not contribute code adapted from other plugins (see [ADR 0005](docs/adr/0005-clean-room-implementation.md)).

## License

[MIT](LICENSE) © Zack Mezera
