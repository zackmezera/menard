# 0002. Translation emits alignment as a by-product

- Status: Accepted
- Date: 2026-10-04

## Context

Sentence alignment can be computed after the fact by comparing two finished texts, or it can be produced at the moment of translation. Post-hoc alignment is a guess: it must infer correspondences the translator already knew. When Menard does the translating, it controls the request and can ask for structure along with prose.

## Decision

When Menard translates, it asks the model, paragraph by paragraph, for an ordered array of source-sentence to target-sentence pairs, allowing one-to-many and many-to-one. The translation note and its sentence maps are both built from that response. Post-hoc alignment exists only for the separate case of an existing translation (the align command), where the model records correspondences without changing a word and flags spans with no counterpart.

## Consequences

- Alignment for translated pairs is exact by construction rather than estimated.
- The translation backend must return structured output. Engines that cannot return sentence-aligned output (DeepL, for example) are a poor fit, since they would force sentence-by-sentence requests and worse prose.
- Translation is per paragraph, which makes long texts naturally resumable, cancellable and incrementally written.
- The response format needs validation: every source sentence must be accounted for, and the target sentences must concatenate to the paragraph written to the note.
