# Architecture decision records

Hard-to-reverse decisions, one per file, numbered in the order they were made. Each record states its status, the context that forced the decision, the decision itself, and its consequences. A superseded record stays in place with its status changed and a pointer to the record that replaces it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-alignment-stored-in-markdown.md) | Alignment is stored in the Markdown, not in plugin data | Accepted |
| [0002](0002-translation-emits-alignment.md) | Translation emits alignment as a by-product | Accepted |
| [0003](0003-two-note-pair-model.md) | Two-note pair model; single-note layout only via split | Accepted |
| [0004](0004-claude-cli-backend-desktop-only.md) | v1 backend is the local `claude` CLI; desktop only | Accepted |
| [0005](0005-clean-room-implementation.md) | Clean-room implementation | Accepted |
| [0006](0006-sentence-map-grammar.md) | Sentence maps store per-link word counts and word-bag hashes | Accepted |
| [0007](0007-native-reading-view-leaves.md) | Reading happens in native reading-view leaves | Accepted, gated by a performance spike |
| [0008](0008-job-state-in-the-translation-note.md) | Job state lives in the translation note | Accepted |
| [0009](0009-write-classes-and-backups.md) | Three write classes; user text is replaced only with a backup | Accepted |
| [0010](0010-merged-units-key-groups.md) | A Menard line may name a key group: merged units | Accepted |
