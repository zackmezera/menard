# Manual QA in a development vault

Unit tests cover the pure modules and the DOM code on hand-built markup. What they cannot cover is Obsidian itself: its reading-view markup, scrolling, editor and metadata cache. This checklist is run by hand in a development vault before the views are considered done (DESIGN.md §14) and before every release.

## Setup

1. Create a fresh vault, for example `~/menard-dev`. Never run these checks in a working vault.
2. Build (`npm run build`) and copy `main.js`, `manifest.json` and `styles.css` into `<dev vault>/.obsidian/plugins/menard/`. Enable Menard.
3. Copy test notes into the vault: the committed fixtures in `test/fixtures/`, plus local copies of the real notes (`@ruizalmotasim`, `@giordanoresistencia`, `@borgessupersticiosa1932`, `@borgesversiones1932`). Work only on copies.
4. Set the options this vault uses: text start heading `Text`; skipped sections add `Argument` and `For My Work`; new note properties `collection: translation`.
5. Open the developer console (Cmd+Opt+I) and keep it open: every check below also passes only with no uncaught errors and no `Menard:` error lines.

## Verification spikes (DESIGN.md §14)

Record the result and the Obsidian version next to each spike. A failure changes only the place named in the table.

| Spike | Check | Pass when |
|---|---|---|
| S1 | Open the facing view on the translated @ruizalmotasim. Scroll through the whole note in both panes; step with `j` from the first sentence to the last; jump with the outline. | `applyScroll` lands on the right source line; `scrollTop` writes stick; stepping across sections that were unloaded by virtualization keeps the highlight; time from key press to the partner held level stays under about 150 ms (Performance panel). |
| S2 | Look at a translated paragraph and the gap after it in reading view; search the vault for `menard:1`. | No empty gap or margin where a Menard line sits. Note whether search finds comment contents. |
| S3 | Inspect the reading-view DOM of a paragraph with a footnote ref, the footnote section, a callout with a title, and an embed. | Footnote ref and definition markup, the class names and the callout title selector match the skip list in `render/dom-projection.ts`. Record the markup for the parity fixtures. |
| S4 | In reading view, press `→` and `j` with a pair open. | The cursor moves and the pane does not also scroll by the arrow key. |
| S5 | In live preview, type in the line above and below a hidden Menard line and a hidden trailing id; move the cursor across them with the arrow keys. | No flicker or jump while typing; the cursor never gets stuck at a hidden id; a user's own id (`^intro`) and comments stay visible. |
| S6 | Quit Obsidian, then start it from the Dock (not a terminal). Run Check Claude connection. | Either it answers, or a keychain prompt appears; record whether the call waits for the prompt and whether the first-run notice mentions it. |
| S7 | Open a paragraph whose id follows an inline comment (`… %%p. 2%% ^p1`); link to it with `[[note#^p1]]`. | The link resolves and the hover preview shows the paragraph. If not, such paragraphs must get an own-line id. |
| S8 | Translate a copy of a note whose preamble has quoted wikilink lists and `course` lists in its properties. | The source's properties are unchanged except the added `translation` key (compare with `git diff` or a copy). |
| S9 | Reading view of `[[a#h]]`, `[[a#^id]]`, `[[a|alias]]` and a trailing id with trailing spaces. | Display text matches what `text/inline.ts` projects; record the results as parity fixtures. Also check an unmatched `*` and `==` in a sentence. |

## Translate, cancel and resume

On a copy of `@ruizalmotasim`:

- [ ] Run Translate note. The preflight shows the languages, the model, the paragraph count, the ids to add, the skipped sections, an estimated time and the disclosure text.
- [ ] Confirm. The source gains ids, `@ruizalmotasim (EN).md` appears beside it with a `translate` marker per paragraph, and both notes link to each other.
- [ ] The progress notice and the status bar update; open the translation note and watch paragraphs replace their markers one at a time.
- [ ] After about ten paragraphs, press Cancel in the notice. No new paragraph is written after the notice says cancelled, `ps aux | grep claude` shows no leftover processes, and the remaining markers are intact.
- [ ] Run Translate note again; it offers to resume and finishes the rest. The summary offers Open facing view.
- [ ] Disable the plugin in the middle of a second job: no `claude` processes remain.
- [ ] Run Check alignment: no pending markers, no degraded maps.

## Split each combined layout

On copies of each note, run Split into source and translation notes:

- [ ] `@ruizalmotasim` (H1 boundary, `[^en-n]` footnotes): footnotes renamed to `[^n]`, backup saved, alignment preview shown.
- [ ] `@giordanoresistencia` (H1 boundary, `[^gen-n]` footnotes, provenance callout, affiliation line).
- [ ] `@borgessupersticiosa1932` (H2 boundary, epigraph with attribution, verse quotes).
- [ ] `@borgesversiones1932` (English only): refused with a reason; nothing written.
- [ ] For each split, joining the new source and translation by hand gives back the original (compare with the backup).
- [ ] `Argument` and `For My Work` sections stay in the source note.

## The vault's nightly chain

On a dev copy of the vault, after translating and splitting:

- [ ] Run the nightly chain (`obsidian-vault-nightly`, `link-vault`, `text-note-enricher`) against the dev copy only.
- [ ] Ids and Menard lines are untouched (`git diff` shows only the chain's own edits, such as name links).
- [ ] Run Check alignment on each pair: maps are exact or repaired, never degraded, after the name rewrite.
- [ ] The translation note is not reported as a malformed text note beyond the known registry false positive.

## Views and accessibility

- [ ] Facing view from either note puts the source left and the translation right, and reuses a pane that already shows the partner.
- [ ] Stacked view: the translation appears under the current sentence; text above it does not move when it moves.
- [ ] Hidden-translation mode: a thin rule shows; Space reveals; the next step hides it again; hover shows nothing.
- [ ] Hover in facing view highlights the partner without scrolling; hover in stacked view shows a floating card that does not push text.
- [ ] Popout window: move a pair into a popout (Open in new window). Reading keys work there, and closing the popout leaves no errors.
- [ ] Light theme, dark theme and one community theme: current, partner, hover, flagged and approximate highlights are all distinguishable.
- [ ] Forced colours (Windows high-contrast, or the Rendering tab of the developer tools): highlights show as outlines.
- [ ] Reduced motion (system setting or the Rendering tab): no transitions, and held level scrolls instantly.

## Uninstall

- [ ] Disable and uninstall Menard. Both notes of every pair open as ordinary Markdown: no visible Menard lines in reading view, ids work as block links, and nothing else in the vault changed.
- [ ] Reinstall: the pairs are recognized again with no other step.
