# 0006. Sentence maps store per-link word counts and word-bag hashes

- Status: Accepted
- Date: 2026-10-04

## Context

ADR 0001 puts sentence alignment in the translation note as hidden `%%` comments but leaves the encoding open. The encoding has to survive small edits to either note, a nightly script that rewrites "Jacques Lacan" into `[[Lacan, Jacques]]` in prose and inside comments, and future changes to Menard's own sentence segmenter. Three encodings were considered. Sentence ordinals are compact but silently wrong after any edit, and go stale whenever the segmenter changes, because the reader must re-segment to find the sentences. Anchor text is robust but bulky, indexed by search, and exposed to the nightly rewrite. Cumulative word positions are compact and segmenter-independent but cannot tell which sentence an added word belongs to.

## Decision

Each sentence unit has one map line in the translation note:

`%%menard:1 <key> <link> <link> …%%`

A *link* pairs a contiguous run of source words with a contiguous run of target words, written `<count>.<hash>/<count>.<hash>`, with `-` for an empty side (a flagged span) and an optional `?` for a loose correspondence. Counts are words of the unit's rendered projection (runs of letters, digits and marks). Hashes are 4 base-36 characters of FNV-1a over the side's normalized words, sorted, so word order does not matter. Pending work is recorded with the same prefix: `%%menard:1 p12 translate%%` and `%%menard:1 p12 align%%`. The `1` is a format version; a new format gets a new number and a new ADR. The exact grammar is in docs/DESIGN.md §4.3.

The reader never segments. It splits a rendered paragraph at the stored word counts, after fitting them to the current text by prefix and suffix matching on the hashes.

## Consequences

- Changing the segmenter or the abbreviation list affects only maps written afterwards.
- Typo fixes, punctuation and quote-style changes, and the nightly name rewrite leave every link exact. An edit that adds or removes words inside one sentence is localized to that link. Edits that span several sentences are shown as approximate, never as silently wrong.
- Map lines contain no prose or capitalized names, so name-linking scripts cannot match them and search indexes only short tokens.
- About 16 characters per link: roughly 7 KB of maps for a 137 KB article.
- A 20-bit hash can collide (about one in a million per comparison); since links are only compared in position, a collision can at worst label one edited sentence exact.
- The format is readable enough to debug by hand but is not meant to be edited by hand. A malformed line is reported and ignored, never rewritten silently.
