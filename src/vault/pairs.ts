/**
 * Pair resolution through frontmatter, and the cache of PairModels.
 * Owner: vault module. DESIGN.md §4.1, §6.
 */
import { TFile, debounce } from "obsidian";
import type { FrontMatterCache } from "obsidian";
import { buildPairModel } from "../align/model";
import { FM } from "../constants";
import { parseOptions } from "../settings";
import { parseNote } from "../text/blocks";
import type { MenardContext, MenardSettings, PairIndex, PairLanguages, PairLink, PairModel, Side } from "../types";

/** Quiet time after the last change before open pairs are rebuilt. */
const REBUILD_DELAY_MS = 250;

/** A frontmatter wikilink: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`. */
const WIKILINK_VALUE_RE = /^\s*\[\[([^[\]]+)\]\]\s*$/;

interface CachedPair {
	source: TFile;
	target: TFile;
	model: PairModel;
}

export class PairStore implements PairIndex {
	/** Each built pair, under both its source and its target path. */
	private readonly cache = new Map<string, CachedPair>();
	/** Rebuild counter per pair, keyed by the source file so it survives renames. */
	private readonly versions = new WeakMap<TFile, number>();
	/** The latest build started per source file; an older build never overwrites a newer one. */
	private readonly builds = new Map<TFile, Promise<PairModel | null>>();
	/** Source files of cached pairs whose notes changed since their last build. */
	private readonly dirty = new Set<TFile>();
	private readonly listeners = new Set<(sourcePath: string) => void>();
	private readonly scheduleRebuild = debounce(() => void this.rebuildDirty(), REBUILD_DELAY_MS, true);

	/** The model-relevant settings the cached models were built with. */
	private settingsKey: string;

	constructor(private readonly ctx: MenardContext) {
		this.settingsKey = modelSettingsKey(ctx.settings());
	}

	/** Registers metadataCache `changed` and vault `rename`/`delete` listeners on ctx.owner; rebuilds are debounced 250 ms. */
	start(): void {
		const { app, owner } = this.ctx;
		owner.registerEvent(app.metadataCache.on("changed", (file) => this.markChanged(file.path)));
		owner.registerEvent(
			app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.renamed(oldPath, file.path);
			}),
		);
		owner.registerEvent(
			app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.deleted(file.path);
			}),
		);
		owner.register(() => this.scheduleRebuild.cancel());
	}

	resolve(file: TFile): { pair: PairLink; side: Side } | null {
		const translation = this.linkedFile(file, FM.translation);
		if (translation && this.linkedFile(translation, FM.source) === file) {
			return { pair: { source: file, target: translation }, side: "source" };
		}
		const source = this.linkedFile(file, FM.source);
		if (source && this.linkedFile(source, FM.translation) === file) {
			return { pair: { source, target: file }, side: "target" };
		}
		return null;
	}

	/** True when the note has a wikilink-valued `translation` or `source` key. */
	mayBePair(path: string): boolean {
		const file = this.ctx.app.vault.getFileByPath(path);
		const frontmatter = file ? this.frontmatter(file) : undefined;
		if (!frontmatter) return false;
		return linkpathOf(frontmatter[FM.translation]) !== null || linkpathOf(frontmatter[FM.source]) !== null;
	}

	async load(file: TFile): Promise<PairModel | null> {
		const resolved = this.resolve(file);
		if (!resolved) return null;
		const { source, target } = resolved.pair;
		const inFlight = this.builds.get(source);
		if (inFlight) return inFlight;
		const cached = this.cache.get(source.path);
		if (cached && cached.source === source && cached.target === target && !this.dirty.has(source)) return cached.model;
		return this.build(resolved.pair);
	}

	peek(path: string): PairModel | null {
		return this.cache.get(path)?.model ?? null;
	}

	/**
	 * Called after the settings are saved. When a setting the models are built
	 * from changed (the text start heading, skipped headings, default
	 * languages), every cached pair is rebuilt (#27).
	 */
	settingsChanged(): void {
		const key = modelSettingsKey(this.ctx.settings());
		if (key === this.settingsKey) return;
		this.settingsKey = key;
		this.invalidateAll();
	}

	/**
	 * Marks every cached or building pair stale: load builds afresh, and after
	 * the debounce each is rebuilt and listeners are notified, so open views
	 * repaint.
	 */
	invalidateAll(): void {
		for (const cached of this.cache.values()) this.dirty.add(cached.source);
		for (const source of this.builds.keys()) this.dirty.add(source);
		// Builds that read the old settings must not become cached models.
		this.builds.clear();
		if (this.dirty.size > 0) this.scheduleRebuild();
	}

	onChange(listener: (sourcePath: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private build(pair: PairLink): Promise<PairModel | null> {
		const promise = this.readAndBuild(pair).then((model) => {
			if (this.builds.get(pair.source) !== promise) return this.cache.get(pair.source.path)?.model ?? model;
			this.builds.delete(pair.source);
			this.forget(pair.source);
			this.cache.set(pair.source.path, { ...pair, model });
			this.cache.set(pair.target.path, { ...pair, model });
			return model;
		});
		this.builds.set(pair.source, promise);
		promise.catch(() => {
			if (this.builds.get(pair.source) === promise) this.builds.delete(pair.source);
		});
		return promise;
	}

	private async readAndBuild({ source, target }: PairLink): Promise<PairModel> {
		const { vault } = this.ctx.app;
		const [sourceText, targetText] = await Promise.all([vault.cachedRead(source), vault.cachedRead(target)]);
		const settings = this.ctx.settings();
		const options = parseOptions(settings);
		const version = (this.versions.get(source) ?? 0) + 1;
		this.versions.set(source, version);
		return buildPairModel({
			sourcePath: source.path,
			targetPath: target.path,
			languages: this.languages(target),
			version,
			source: parseNote(sourceText, options),
			target: parseNote(targetText, { textStartHeading: "", skipHeadings: options.skipHeadings }),
		});
	}

	private async rebuildDirty(): Promise<void> {
		for (const source of [...this.dirty]) {
			if (!this.dirty.delete(source)) continue;
			const resolved = this.resolve(source);
			let sourcePath = source.path;
			if (resolved) {
				try {
					const model = await (this.builds.get(source) ?? this.build(resolved.pair));
					if (model) sourcePath = model.sourcePath;
				} catch (error) {
					console.error("Menard: could not rebuild the pair model.", error);
					this.forget(source);
					continue;
				}
			} else {
				this.forget(source);
			}
			this.notify(sourcePath);
		}
	}

	private markChanged(path: string): void {
		const cached = this.cache.get(path);
		if (!cached) return;
		this.dirty.add(cached.source);
		// A build that read the notes before this change must not become the cached model.
		this.builds.delete(cached.source);
		this.scheduleRebuild();
	}

	private renamed(oldPath: string, newPath: string): void {
		const cached = this.cache.get(oldPath);
		if (!cached) return;
		this.cache.delete(oldPath);
		this.cache.set(newPath, cached);
		this.markChanged(newPath);
	}

	private deleted(path: string): void {
		const cached = this.cache.get(path);
		if (!cached) return;
		this.forget(cached.source);
		this.dirty.add(cached.source);
		this.scheduleRebuild();
	}

	/** Drops every cache entry of the pair whose source is `source`. */
	private forget(source: TFile): void {
		for (const [path, cached] of this.cache) {
			if (cached.source === source) this.cache.delete(path);
		}
	}

	private notify(sourcePath: string): void {
		for (const listener of [...this.listeners]) listener(sourcePath);
	}

	private frontmatter(file: TFile): FrontMatterCache | undefined {
		return this.ctx.app.metadataCache.getFileCache(file)?.frontmatter;
	}

	/** The note that `file`'s frontmatter `key` links to, if it resolves to another Markdown note. */
	private linkedFile(file: TFile, key: string): TFile | null {
		const linkpath = linkpathOf(this.frontmatter(file)?.[key]);
		if (linkpath === null) return null;
		const dest = this.ctx.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
		return dest && dest !== file && dest.extension === "md" ? dest : null;
	}

	private languages(target: TFile): PairLanguages {
		const settings = this.ctx.settings();
		const frontmatter = this.frontmatter(target);
		return {
			source: nonEmptyString(frontmatter?.[FM.sourceLanguage]) ?? settings.defaultSourceLanguage,
			target: nonEmptyString(frontmatter?.[FM.targetLanguage]) ?? settings.defaultTargetLanguage,
		};
	}
}

/** The settings a PairModel depends on, as one comparable string. */
function modelSettingsKey(settings: MenardSettings): string {
	const options = parseOptions(settings);
	return JSON.stringify([options.textStartHeading, options.skipHeadings, settings.defaultSourceLanguage, settings.defaultTargetLanguage]);
}

/**
 * The linkpath of a frontmatter wikilink value, without alias or heading;
 * null for anything else. An unquoted `[[Note]]` is YAML for the nested
 * list [["Note"]], and counts as the same link.
 */
export function linkpathOf(value: unknown): string | null {
	const inner = typeof value === "string" ? WIKILINK_VALUE_RE.exec(value)?.[1] : unquotedLink(value);
	if (inner === undefined) return null;
	const linkpath = (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
	return linkpath === "" ? null : linkpath;
}

function unquotedLink(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length !== 1) return undefined;
	const inner: unknown = value[0];
	return Array.isArray(inner) && inner.length === 1 && typeof inner[0] === "string" ? inner[0] : undefined;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
