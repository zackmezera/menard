/**
 * Shared contracts. Every module implements or consumes these types; none
 * of them is owned by a single module. Change this file only through the
 * design (docs/DESIGN.md §12), never as a side effect of implementing one
 * module. Type-only imports from `obsidian` keep it safe for pure modules.
 */
import type { App, Component, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { MenardError } from "./errors";

// ─── Identity ───────────────────────────────────────────────────────────────

export type Side = "source" | "target";

/**
 * Key shared by a source unit and its translation.
 * - A block id: "p12" (Menard-allocated) or a user's existing id ("intro-1").
 * - "fn:<label>" for a footnote definition, label normalized (§4.5).
 * - "h:<n>" for a heading, paired through the next paired unit; in memory only, never written.
 */
export type UnitKey = string;

/** Character range [start, end) in some string. */
export interface CharRange {
	start: number;
	end: number;
}

/** Line range [start, end), 0-based, in a note's text. */
export interface LineRange {
	start: number;
	end: number;
}

// ─── Markdown structure (text module) ───────────────────────────────────────

/** Blocks Menard aligns. Sentence units get maps; the rest align whole. */
export type UnitKind = "paragraph" | "quote" | "callout" | "list" | "table" | "footnote" | "heading";

/** Every block kind the scanner reports. */
export type BlockKind =
	| UnitKind
	/** Code fence, math block, HTML block, embed-only line, thematic break, user comment block. Copied as is. */
	| "verbatim"
	/** A whole Menard line: sentence map or pending-task marker. */
	| "menard";

export const SENTENCE_UNIT_KINDS: readonly UnitKind[] = ["paragraph", "quote", "callout"];

/** Where a block sits relative to the note's aligned text. */
export type BlockRegion =
	/** Before the text start (frontmatter, title, buttons, embeds…). Never aligned or translated. */
	| "preamble"
	/** Aligned and translated. */
	| "text"
	/** Under a skipped heading (bibliography, personal sections). Never aligned or translated. */
	| "skipped";

export interface Block {
	kind: BlockKind;
	region: BlockRegion;
	/** The block's own lines, excluding an own-line id and any trailing blank lines. */
	lines: LineRange;
	/** The block's lines exactly as written, minus its block id. */
	raw: string;
	/**
	 * Inline Markdown to project, segment and translate:
	 * paragraph: `raw` (soft line breaks kept as "\n");
	 * quote: lines with the `>` prefix removed, blank `>` lines kept as "";
	 * callout: as quote, without the `[!type] Title` header line;
	 * footnote: the definition text without `[^label]:`, continuation lines dedented;
	 * heading: the heading text; list, table, verbatim, menard: `raw`.
	 */
	body: string;
	/** Existing block id (without `^`), if any. */
	id: string | null;
	idStyle: "trailing" | "own-line" | null;
	/** Line of an own-line id, or of the line carrying a trailing id. */
	idLine: number | null;
	headingLevel?: number;
	calloutType?: string;
	calloutTitle?: string;
	/** Footnote label as written, e.g. "3" or "en-3". */
	footnoteLabel?: string;
}

export interface NoteStructure {
	eol: "\n" | "\r\n";
	/** Frontmatter lines including both `---` fences, or null. */
	frontmatter: LineRange | null;
	/** All blocks in document order, every region. */
	blocks: readonly Block[];
	/** Every block id present in the note, for collision-free allocation. */
	usedIds: ReadonlySet<string>;
	lineCount: number;
}

export interface ParseOptions {
	/** Heading text (any level, case-insensitive) after which the aligned text starts; "" = right after frontmatter. */
	textStartHeading: string;
	/** Heading texts (case-insensitive, exact after trim) whose sections are skipped. */
	skipHeadings: readonly string[];
	/**
	 * Only when textStartHeading is "": find the start safely instead (a
	 * heading named "Text", else after leading link, button and embed lines).
	 * Set for source notes by parseOptions; translation notes never use it.
	 * DESIGN.md §5.1.
	 */
	autoTextStart?: boolean;
}

/** The visible text of some inline Markdown or DOM, NFC-normalized. */
export interface Projection {
	text: string;
	/** For each index of `text`, the index in the input it came from. */
	toInput: Int32Array;
}

/** A word: a maximal run of letters, digits and marks in a projection. */
export interface Word {
	start: number;
	end: number;
	/** NFKD, marks stripped, lower-cased. */
	norm: string;
}

export interface SegmentRules {
	/** BCP 47 code for Intl.Segmenter. */
	lang: string;
	/** Lower-cased abbreviations without their final period. */
	abbreviations: ReadonlySet<string>;
	/** Also split before " —" dialogue dashes. */
	splitDialogue: boolean;
	/** "space": "\n" is a soft break inside a sentence (paragraphs); "boundary": every "\n" ends a sentence (quotes, verse). */
	lineBreaks: "space" | "boundary";
}

/** A text insertion at a character offset of the file's current text. */
export interface Insert {
	at: number;
	text: string;
}

/** A replacement of [from, to) whose current content must equal `expect`. */
export interface Replacement {
	from: number;
	to: number;
	expect: string;
	text: string;
}

// ─── Sentence maps and alignment (align module) ─────────────────────────────

/** One side of a link: its word count and order-insensitive word-bag hash. */
export interface SideSig {
	/** ≥ 1. */
	count: number;
	/** 4 lower-case base-36 characters. */
	hash: string;
}

/**
 * The alignment unit: a contiguous run of source words paired with a
 * contiguous run of target words. A null side is a flagged span.
 */
export interface MapLink {
	src: SideSig | null;
	tgt: SideSig | null;
	/** The aligner judged the correspondence approximate. */
	loose: boolean;
}

/**
 * `key` is the line's first key. `group` is present only on a merged unit
 * (ADR 0010): every key of its key group `p3+p4`, in order, `key` first.
 */
export type MenardLine =
	| { kind: "map"; key: UnitKey; group?: readonly UnitKey[]; links: readonly MapLink[] }
	/** "translate": the unit's translation belongs here. "align": the unit above needs a map. */
	| { kind: "marker"; key: UnitKey; group?: readonly UnitKey[]; task: "translate" | "align" };

export interface MenardLineOccurrence {
	/** 0-based line in the note. */
	line: number;
	raw: string;
	/** null when the line is Menard-owned but malformed. */
	parsed: MenardLine | null;
	error?: string;
}

export interface WordRange {
	start: number;
	end: number;
}

/** How one link's stored side fits the current words. */
export type LinkFit = "exact" | "edited" | "approximate" | "lost" | "empty";

export interface ReconciledSide {
	/** exact: every link matched; repaired: some edited, positions certain; degraded: positions estimated or unknown. */
	status: "exact" | "repaired" | "degraded";
	/** One per link, in link order: word indices [start, end). Empty range for null or lost sides. */
	ranges: readonly WordRange[];
	fits: readonly LinkFit[];
}

export interface PairUnit {
	/** For a merged unit, the first key of its group. */
	key: UnitKey;
	kind: UnitKind;
	/** For a merged unit, the first block of the side. */
	source: Block | null;
	target: Block | null;
	/**
	 * A merged unit (ADR 0010): consecutive paragraphs read as one. Each side
	 * is its blocks in group order, and the map's words run across them.
	 */
	group?: { keys: readonly UnitKey[]; source: readonly Block[]; target: readonly Block[] };
	/** The parsed sentence map, if any (sentence units only). */
	map: Extract<MenardLine, { kind: "map" }> | null;
	/** A pending task recorded in the translation note. */
	pending: "translate" | "align" | null;
}

/** A reading-cursor position. `link` is 1-based; null means the whole unit. */
export interface CursorStop {
	unit: UnitKey;
	link: number | null;
}

/** Corresponding line spans in both notes, for scroll sync. */
export interface ScrollAnchor {
	key: UnitKey;
	source: LineRange;
	target: LineRange;
}

export interface PairLanguages {
	source: string;
	target: string;
}

/** Immutable model of a pair, built from both notes' text. Pure. */
export interface PairModel {
	readonly sourcePath: string;
	readonly targetPath: string;
	readonly languages: PairLanguages;
	/** Increments on every rebuild of the same pair. */
	readonly version: number;
	/** Paired and one-sided units of the text region, in source order (translation-only units follow their predecessor). */
	readonly units: readonly PairUnit[];
	/** Menard lines that parse badly or whose key matches no unit. */
	readonly problems: readonly MenardLineOccurrence[];
	unit(key: UnitKey): PairUnit | undefined;
	/** The unit whose block covers `line` on `side`, or whose own-line id or map sits on it. */
	unitAtLine(side: Side, line: number): PairUnit | undefined;
	/** Cursor stops in reading order: one per link with a non-empty source side, or one per unit without a usable map. */
	stops(): readonly CursorStop[];
	/** Paired units and headings in order, for scroll sync. */
	anchors(): readonly ScrollAnchor[];
}

/** Result of pairing two notes' units for the align command. */
export interface UnitMatch {
	/** Indices into each unit list, in order; one on each side, or several on one side for a merge (2-1, 1-2, up to 3). */
	pairs: readonly { source: readonly number[]; target: readonly number[]; doubtful: boolean }[];
	/** Indices into the source unit list left unpaired. */
	sourceOnly: readonly number[];
	targetOnly: readonly number[];
}

// ─── Backend and prompting (llm module) ─────────────────────────────────────

export interface BackendRequest {
	system: string;
	/** Sent on stdin. */
	prompt: string;
	/** JSON Schema for structured output. */
	schema: object;
	model: string;
	timeoutMs: number;
	signal: AbortSignal;
}

export interface BackendResult {
	/** The structured output, not yet validated. */
	output: unknown;
	durationMs: number;
}

/** Seam for the CLI backend, test fakes and future BYOK backends. Throws MenardError (cli-* codes, cancelled). */
export interface TranslationBackend {
	readonly name: string;
	run(request: BackendRequest): Promise<BackendResult>;
}

export interface DetectResult {
	path: string | null;
	via: "setting" | "candidate" | "shell" | null;
	/** Every path checked, for the error message. */
	tried: readonly string[];
}

/** A source unit after verbatim tokens were swapped for placeholders. */
export interface Protected {
	text: string;
	tokens: readonly { placeholder: string; original: string }[];
}

/** The pieces of a prompt; the backend adds model, timeout and signal. */
export interface PromptParts {
	system: string;
	prompt: string;
	schema: object;
}

export interface TranslateUnitInput {
	key: UnitKey;
	kind: "paragraph" | "quote" | "callout";
	languages: PairLanguages;
	documentTitle: string;
	/** Numbered source sentences as protected Markdown, 1-based in order. */
	sentences: readonly string[];
	calloutTitle?: string;
	/** Previous unit's source and translation projections, each ≤ 1,500 characters. */
	context?: { source: string; target?: string };
	extraInstructions: string;
	/** Validation errors from the previous attempt, fed back on retry. */
	retryErrors?: readonly string[];
}

export interface TranslateGroup {
	/** Consecutive 1-based source sentence numbers; [] only for a translator's addition. */
	src: readonly number[];
	/** Target Markdown for those sentences, placeholders intact. */
	markdown: string;
}

export interface TranslateOutput {
	groups: readonly TranslateGroup[];
	calloutTitle?: string;
}

export interface AlignUnitInput {
	key: UnitKey;
	languages: PairLanguages;
	/** Projection text of each source sentence, 1-based in order. */
	source: readonly string[];
	target: readonly string[];
	retryErrors?: readonly string[];
}

export interface AlignGroup {
	src: readonly number[];
	tgt: readonly number[];
	loose: boolean;
}

export interface AlignOutput {
	groups: readonly AlignGroup[];
}

/** One paragraph-like unit of a section, for content-based pairing (DESIGN.md §7.2). */
export interface PairingUnit {
	kind: UnitKind;
	words: number;
	/** Its first words and, when longer, its last words, joined by " … ". */
	excerpt: string;
}

export interface PairingInput {
	languages: PairLanguages;
	source: readonly PairingUnit[];
	target: readonly PairingUnit[];
	retryErrors?: readonly string[];
}

/** 1-based unit numbers; one side may be empty (unpaired) or hold up to 3 when the other holds 1. */
export interface PairingGroup {
	src: readonly number[];
	tgt: readonly number[];
}

export interface PairingOutput {
	groups: readonly PairingGroup[];
}

/** Lists, tables and footnotes: translated whole, no sentence map. */
export interface PlainUnitInput {
	key: UnitKey;
	kind: "list" | "table" | "footnote";
	languages: PairLanguages;
	documentTitle: string;
	/** Protected Markdown of the whole block body. */
	markdown: string;
	extraInstructions: string;
	retryErrors?: readonly string[];
}

export interface PlainOutput {
	markdown: string;
}

export interface OutlineInput {
	languages: PairLanguages;
	documentTitle: string;
	headings: readonly string[];
	extraInstructions: string;
}

export interface OutlineOutput {
	headings: readonly string[];
}

export type Validation<T> = { ok: true; value: T; warnings: readonly string[] } | { ok: false; errors: readonly string[] };

// ─── Vault access (vault module) ────────────────────────────────────────────

declare const backupBrand: unique symbol;

/** Proof that a full copy of a file was saved. Only BackupStore mints it. */
export interface BackupToken {
	readonly path: string;
	readonly backupPath: string;
	/** Hash of the content that was backed up; a replace checks it. */
	readonly contentHash: string;
	readonly [backupBrand]: true;
}

export type ComputeInserts = (text: string) => readonly Insert[] | "noop" | "conflict";
export type ComputeReplacements = (text: string) => readonly Replacement[] | "noop" | "conflict";

export type WriteOutcome = { ok: true; changed: boolean } | { ok: false; error: MenardError };

/**
 * The only path from Menard to note content. Three write classes (ADR 0009):
 * insert-only, rewrite of Menard-owned lines, and backed-up replace.
 * Every method recomputes its edit inside vault.process on the current text.
 */
export interface NoteWriter {
	/** Pure insertions; verified by removing them and comparing with the original. */
	insert(file: TFile, compute: ComputeInserts): Promise<WriteOutcome>;
	/** Replace whole Menard lines (markers, maps) only; each `expect` must match MENARD_LINE_RE. */
	rewriteOwned(file: TFile, compute: ComputeReplacements): Promise<WriteOutcome>;
	/** Replace user text; requires a backup of the file's current content. */
	replace(file: TFile, backup: BackupToken, compute: ComputeReplacements): Promise<WriteOutcome>;
	/** Create a new note; fails with file-exists rather than overwrite. */
	create(path: string, content: string): Promise<TFile>;
	/** Set Menard's frontmatter keys only, via processFrontMatter. */
	setFrontmatter(file: TFile, entries: Readonly<Record<string, string>>): Promise<void>;
	/** Move a file Menard created in this job to the trash (recoverable). */
	trashCreated(file: TFile): Promise<void>;
}

export interface BackupStore {
	save(file: TFile): Promise<BackupToken>;
	/** Folder holding backups, vault-relative. */
	readonly folder: string;
}

export interface PairLink {
	source: TFile;
	target: TFile;
}

/** Finds pairs and serves their models, rebuilt when either note changes. */
export interface PairIndex {
	/** The pair a file belongs to, if both notes link to each other. */
	resolve(file: TFile): { pair: PairLink; side: Side } | null;
	/** Cheap frontmatter-only test for gating; does not check reciprocity. */
	mayBePair(path: string): boolean;
	/** The current model, building it if needed. */
	load(file: TFile): Promise<PairModel | null>;
	/** The cached model for a source or target path, if built. */
	peek(path: string): PairModel | null;
	/** Called with the source path after a pair's model is rebuilt. Returns an unsubscribe function. */
	onChange(listener: (sourcePath: string) => void): () => void;
}

// ─── Rendering and reading (render, reader modules) ─────────────────────────

/** Notified by the post-processor; implemented by the reader. */
export interface SectionListener {
	/** A section of `path` was wrapped (or holds a unit) and is in the DOM tree being built. */
	sectionRendered(path: string, el: HTMLElement): void;
}

/** Renders the translation of one stop into an element, for the stacked view. */
export interface GlossSource {
	/** Renders the target side of `stop` into `into`; resolves false if there is nothing to show. */
	render(model: PairModel, stop: CursorStop, into: HTMLElement, owner: Component): Promise<boolean>;
}

/** What integration needs from the reader to wire commands. */
export interface ReaderApi {
	openFacing(file: TFile): Promise<void>;
	/** Toggles stacked view on a source leaf in reading view; false if not applicable. */
	toggleStacked(leaf: WorkspaceLeaf): boolean;
	/** Steps the cursor of the active session; false if there is none. */
	step(by: "link" | "unit", delta: 1 | -1): boolean;
	/** Stacked view in reveal mode with a concealed gloss under the cursor. */
	canReveal(): boolean;
	reveal(): boolean;
	/** The active session is in stacked view. */
	canToggleRevealMode(): boolean;
	toggleRevealMode(): boolean;
	/** Re-applies settings the open sessions read, such as reveal mode. */
	settingsChanged(): void;
	clearCursor(): boolean;
	/** The unit under the active session's cursor, for re-translate, re-align and copy-link. */
	currentUnit(): { pair: PairLink; key: UnitKey } | null;
	hasActiveSession(): boolean;
}

/** What integration needs from jobs to wire commands. */
export interface JobsApi {
	canTranslate(file: TFile): boolean;
	translate(file: TFile): Promise<void>;
	canAlign(file: TFile): boolean;
	align(file: TFile): Promise<void>;
	canSplit(file: TFile, text: string): boolean;
	split(file: TFile): Promise<void>;
	canBatch(folder: TFolder | null): boolean;
	/** Translate or align every source note directly in the folder (DESIGN.md §7.7). */
	batch(folder: TFolder): Promise<void>;
	retranslate(pair: PairLink, key: UnitKey): Promise<void>;
	realign(pair: PairLink, key: UnitKey): Promise<void>;
	checkPair(file: TFile): Promise<void>;
	checkClaude(): Promise<void>;
	isRunning(): boolean;
	/** Cancels the running job; false if none. */
	cancel(): boolean;
}

// ─── Settings and wiring ────────────────────────────────────────────────────

export interface MenardSettings {
	// Translation backend
	/** Absolute path to `claude`; "" means auto-detect. */
	claudePath: string;
	/** Model alias or full id passed to --model. */
	model: string;
	/** Parallel CLI calls, 1–4. */
	concurrency: number;
	timeoutSeconds: number;
	/** Retries per unit after invalid output, 0–3. */
	maxRetries: number;

	// Languages
	defaultSourceLanguage: string;
	defaultTargetLanguage: string;
	/** Extra abbreviations, one language per line: "es: art núm". */
	extraAbbreviations: string;
	splitDialogue: boolean;
	/** Appended to every translation prompt. */
	extraInstructions: string;

	// Notes
	textStartHeading: string;
	/** Comma- or newline-separated heading texts. */
	skipHeadings: string;
	/** Boundary heading for the split command. */
	translationHeading: string;
	/** `key: value` lines added to new translation notes. */
	newNoteProperties: string;

	// Reading
	readingKeys: boolean;
	hoverPartner: boolean;
	/** Stacked view starts with the translation hidden until revealed. */
	revealMode: boolean;
	/** Fade every sentence but the current one and its partner. */
	dimInactive: boolean;
	/** Opacity of faded sentences, in percent. */
	dimOpacity: number;

	// Editing
	hideBlockIds: boolean;
	hideSentenceMaps: boolean;

	// Safety
	/** Backups kept per vault, newest first. */
	backupCount: number;
}

/** What every non-pure module receives from the plugin. */
export interface MenardContext {
	app: App;
	/** Current settings; read on use, never cached. */
	settings(): MenardSettings;
	/** Lifetime owner for register/registerEvent/registerDomEvent. Never pass it to MarkdownRenderer. */
	owner: Component;
}
