# Menard: context

The ubiquitous language of the plugin. Code, issues, docs and UI copy use these terms with these meanings.

**Pair.** A source note and its translation note, linked to each other through frontmatter (`translation:` on the source, `source:` on the translation). The unit Menard reads, translates and aligns.

**Source note.** The note holding the original-language text, for example a Spanish essay. The default reading surface.

**Translation note.** The note holding the target-language text, named after its source with a language suffix (`@citekey (EN).md`) and stored beside it. Real Markdown, written into the vault, editable like any other note.

**Paragraph ID.** A block ID (` ^p12`) appended to a paragraph. The same ID on both notes of a pair marks corresponding paragraphs. Hidden while reading; also linkable (`[[@citekey#^p12]]`).

**Sentence map.** A hidden `%%menard:1 …%%` line, one per paragraph-like unit in the translation note, listing the unit's links in order. Each link records the word count and a short word-bag hash of its source side and its target side, so one-to-many and many-to-one correspondences are single links (ADR 0006).

**Alignment.** The full set of correspondences across a pair: paragraph IDs plus sentence maps. Lives in the Markdown, never in plugin data.

**Flagged span.** A stretch of source or translation that has no counterpart in the other note. Recorded as unaligned rather than forced into a match.

**Current sentence.** The single link the reader is on, usually one source sentence. Its partner in the translation is highlighted.

**Reading cursor.** The mechanism that holds the current sentence and moves it: arrow keys or `j`/`k` to step, a click to jump.

**Facing view.** Source and translation in two side-by-side panes, scroll-synced by paragraph, with the partner of the current sentence held level.

**Stacked view.** The source page alone, with the translation of the current sentence shown directly beneath it.

**Reveal.** A mode of the stacked view in which even the current sentence's translation stays hidden until the reader asks for it with a key.

**Split.** The one-time command that turns a single note containing both texts (a `# Text` section and a `# English translation` section) into a pair, aligning as it goes.

**Hover.** A light secondary interaction: pointing at a sentence faintly shows its partner without moving the reading cursor.

**Unit.** A block Menard aligns: a paragraph, quote or callout (with a sentence map), or a list, table or footnote (aligned whole). Headings align by their order and are not units with ids.

**Merged unit.** Consecutive paragraphs read as one unit because the translation merged or split them: two Spanish paragraphs rendered as one English paragraph (2-1), or one rendered as two (1-2). Every paragraph keeps its own id; the map line names them all as a key group, `%%menard:1 p3+p4 …%%`, and its links run across them in order (ADR 0010).

**Paragraph pairing.** The first step of Align: deciding which paragraphs of the two notes render each other, by content, before any sentence is aligned. Produces 1-1 pairs, merged units and unpaired paragraphs.

**Link.** The alignment unit inside a paragraph: a contiguous run of source words paired with a contiguous run of target words. One sentence translated as two is one link, and so is two translated as one. A link with an empty side is a flagged span.

**Loose link.** A link the aligner judged approximate, for example a heavy paraphrase. Shown, but marked.

**Projection.** The text a reader actually sees in a unit, with Markdown syntax, footnote markers and comments removed. Word counts, hashes and sentence boundaries are all measured on it.

**Text region.** The part of a note that Menard aligns: everything after the frontmatter, or after a chosen start heading, except skipped sections.

**Skipped section.** A section under a heading Menard ignores, such as a bibliography or the reader's own notes. Never translated, aligned or given ids.

**Pending marker.** A hidden `%%menard:1 p12 translate%%` or `%%menard:1 p12 align%%` line recording work a job has yet to do. Running the job again resumes from the markers.

**Fit.** How a stored link matches the text as it is now: exact, edited (positions certain, words changed), approximate (positions estimated), or lost.

**Stop.** A place the reading cursor can rest: one link, or a whole unit when there is no usable sentence map.

**Held level.** In the facing view, the partner of the current sentence is scrolled to the same height as the current sentence.

**Gloss.** In the stacked view, the translation of the current sentence, shown directly beneath it.

**Chapter note.** A source note holding one chapter of a book, imported from an EPUB: `@citekey/NN Title.md`, with `book`, `chapter`, `originalLanguage` and `sourceEdition` properties. Translated and aligned like any source note.

**Hub note.** `@citekey.md` beside a book's chapter folder, listing its chapter notes. Import writes one only when none exists.

**Page marker.** An inline `%%p. N%%` comment at the point where printed page N begins. Hidden while reading, protected from translation, never moved once written. `pageSource` records where markers came from: `epub-pagelist` (the EPUB's own page breaks) or `pdf-matched` (located from a PDF's page openings).

**Page opening.** The first letters of a PDF page's body text, with running head and folio removed, reduced to bare lowercase letters. What page-marker placement searches for in a note.

