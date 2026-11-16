/**
 * An in-memory stand-in for the parts of Obsidian's App that the vault
 * module uses: a vault with process/read/cachedRead/create and an adapter,
 * a metadata cache that serves frontmatter and resolves links by basename,
 * and a file manager with processFrontMatter and trashFile.
 */
import { Events, TFile } from "obsidian";
import type { App } from "obsidian";

type Frontmatter = Record<string, unknown>;

/** The mock TFile takes its path; the real typings declare no constructor arguments. */
const makeFile = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

export class FakeAdapter {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		const folder = path.slice(0, path.lastIndexOf("/"));
		if (!this.folders.has(folder)) throw new Error(`No folder ${folder}`);
		this.files.set(path, data);
	}

	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		const files = [...this.files.keys()].filter((path) => path.slice(0, path.lastIndexOf("/")) === folder);
		return { files, folders: [] };
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
}

export class FakeVault extends Events {
	/** Deliberately not ".obsidian": the config folder is user-configurable. */
	readonly configDir = ".config-dir";
	readonly adapter = new FakeAdapter();
	private readonly notes = new Map<string, { file: TFile; text: string }>();
	/** Highest number of `process` callbacks in flight at once. */
	maxConcurrentProcess = 0;
	private activeProcess = 0;
	readonly cachedReads: string[] = [];

	constructor(private readonly metadata: FakeMetadataCache) {
		super();
	}

	/** Adds a note, with optional frontmatter served by the metadata cache. */
	seed(path: string, text: string, frontmatter?: Frontmatter): TFile {
		const file = makeFile(path);
		this.notes.set(path, { file, text });
		if (frontmatter) this.metadata.frontmatter.set(path, { ...frontmatter });
		return file;
	}

	/** Changes a note as the user would, without going through Menard. */
	edit(file: TFile, text: string): void {
		this.entry(file).text = text;
	}

	text(file: TFile): string {
		return this.entry(file).text;
	}

	files(): TFile[] {
		return [...this.notes.values()].map((note) => note.file);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		this.activeProcess++;
		this.maxConcurrentProcess = Math.max(this.maxConcurrentProcess, this.activeProcess);
		try {
			await tick();
			const note = this.entry(file);
			note.text = fn(note.text);
			await tick();
			return note.text;
		} finally {
			this.activeProcess--;
		}
	}

	async read(file: TFile): Promise<string> {
		await tick();
		return this.entry(file).text;
	}

	async cachedRead(file: TFile): Promise<string> {
		this.cachedReads.push(file.path);
		await tick();
		return this.entry(file).text;
	}

	async create(path: string, text: string): Promise<TFile> {
		if (this.notes.has(path)) throw new Error("File already exists.");
		return this.seed(path, text);
	}

	getFileByPath(path: string): TFile | null {
		return this.notes.get(path)?.file ?? null;
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.getFileByPath(path);
	}

	rename(file: TFile, newPath: string): void {
		const note = this.entry(file);
		const oldPath = file.path;
		this.notes.delete(oldPath);
		const renamed = makeFile(newPath);
		file.path = newPath;
		file.name = renamed.name;
		file.basename = renamed.basename;
		this.notes.set(newPath, note);
		const frontmatter = this.metadata.frontmatter.get(oldPath);
		this.metadata.frontmatter.delete(oldPath);
		if (frontmatter) this.metadata.frontmatter.set(newPath, frontmatter);
		this.trigger("rename", file, oldPath);
	}

	delete(file: TFile): void {
		this.notes.delete(file.path);
		this.metadata.frontmatter.delete(file.path);
		this.trigger("delete", file);
	}

	private entry(file: TFile): { file: TFile; text: string } {
		const note = this.notes.get(file.path);
		if (!note) throw new Error(`No note at ${file.path}`);
		return note;
	}
}

export class FakeMetadataCache extends Events {
	readonly frontmatter = new Map<string, Frontmatter>();
	vault!: FakeVault;

	getFileCache(file: TFile): { frontmatter?: Frontmatter } | null {
		if (!this.vault.getFileByPath(file.path)) return null;
		const frontmatter = this.frontmatter.get(file.path);
		return frontmatter ? { frontmatter } : {};
	}

	/** Resolves a linkpath by full path (with or without `.md`) or by basename. */
	getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
		const files = this.vault.files();
		return (
			files.find((file) => file.path === linkpath || file.path === `${linkpath}.md`) ??
			files.find((file) => file.basename === linkpath) ??
			null
		);
	}

	fileToLinktext(file: TFile, _sourcePath: string): string {
		return file.basename;
	}

	/** Replaces a note's frontmatter and fires `changed`, as Obsidian does after reindexing. */
	setFrontmatter(file: TFile, frontmatter: Frontmatter): void {
		this.frontmatter.set(file.path, { ...frontmatter });
		this.trigger("changed", file, this.vault.text(file), {});
	}

	/** Fires `changed` for a note whose body changed. */
	changed(file: TFile): void {
		this.trigger("changed", file, this.vault.text(file), {});
	}
}

export class FakeFileManager {
	readonly trashed: string[] = [];

	constructor(
		private readonly vault: FakeVault,
		private readonly metadata: FakeMetadataCache,
	) {}

	async processFrontMatter(file: TFile, fn: (frontmatter: Frontmatter) => void): Promise<void> {
		await Promise.resolve();
		const frontmatter = { ...(this.metadata.frontmatter.get(file.path) ?? {}) };
		fn(frontmatter);
		this.metadata.frontmatter.set(file.path, frontmatter);
	}

	async trashFile(file: TFile): Promise<void> {
		await Promise.resolve();
		this.trashed.push(file.path);
		this.vault.delete(file);
	}
}

export interface FakeApp {
	app: App;
	vault: FakeVault;
	metadataCache: FakeMetadataCache;
	fileManager: FakeFileManager;
}

export function createFakeApp(): FakeApp {
	const metadataCache = new FakeMetadataCache();
	const vault = new FakeVault(metadataCache);
	metadataCache.vault = vault;
	const fileManager = new FakeFileManager(vault, metadataCache);
	const app = { vault, metadataCache, fileManager } as unknown as App;
	return { app, vault, metadataCache, fileManager };
}
