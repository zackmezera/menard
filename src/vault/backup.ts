/**
 * Full-file backups before any replacement of user text. Owner: vault
 * module. DESIGN.md §8.3.
 */
import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { fnv1a32 } from "../align/signature";
import { MenardError } from "../errors";
import type { BackupStore, BackupToken } from "../types";

/** `<yyyymmdd-hhmmss>-<stem>.md` or `… (<n>).md`: the names this store writes and prunes. */
const BACKUP_NAME_RE = /^(\d{8}-\d{6})-(.+?)(?: \((\d+)\))?\.md$/;

/**
 * Pruning never removes one of a note's newest this-many backups, however
 * many other notes were backed up since (issue #32). Notes are told apart
 * by the basename in the backup's name.
 */
export const BACKUPS_KEPT_PER_NOTE = 3;

export class VaultBackupStore implements BackupStore {
	/** `<pluginFolder>/backups`, normalized. */
	readonly folder: string;

	/** `pluginFolder` is the plugin's install folder (its manifest's `dir`), so backups leave with the plugin. */
	constructor(
		private readonly app: App,
		private readonly keep: () => number,
		pluginFolder: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.folder = normalizePath(`${pluginFolder}/backups`);
	}

	/** Copies the file's current content to `<folder>/<yyyymmdd-hhmmss>-<basename>.md`, prunes to `keep()`, returns a token. */
	async save(file: TFile): Promise<BackupToken> {
		try {
			const content = await this.app.vault.read(file);
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.folder))) await adapter.mkdir(this.folder);
			const backupPath = await this.freePath(`${timestamp(this.now())}-${file.basename}`);
			await adapter.write(backupPath, content);
			await this.prune(backupPath);
			return mintToken(file.path, backupPath, contentHash(content));
		} catch (error) {
			throw new MenardError("backup-failed", `Could not back up ${file.path} before changing it.`, error);
		}
	}

	/** `<stem>.md`, or `<stem> (2).md` and so on when a backup from the same second exists. */
	private async freePath(stem: string): Promise<string> {
		let path = normalizePath(`${this.folder}/${stem}.md`);
		for (let n = 2; await this.app.vault.adapter.exists(path); n++) {
			path = normalizePath(`${this.folder}/${stem} (${n}).md`);
		}
		return path;
	}

	/**
	 * Removes the oldest backups beyond `keep()`, except the one just written
	 * and each note's newest BACKUPS_KEPT_PER_NOTE, so re-translations of other
	 * notes cannot prune the only backup of a note. Within one second,
	 * `… (n).md` is newer than `… (n-1).md`. A keep() that is not a finite
	 * number prunes nothing rather than everything.
	 */
	private async prune(justWritten: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const requested = this.keep();
		if (!Number.isFinite(requested)) return;
		const keep = Math.max(1, Math.floor(requested));
		const { files } = await adapter.list(this.folder);
		const backups = files.flatMap((path) => {
			const match = BACKUP_NAME_RE.exec(path.slice(path.lastIndexOf("/") + 1));
			return match ? [{ path, time: match[1] ?? "", note: match[2] ?? "", copy: Number(match[3] ?? 1) }] : [];
		});
		const newestFirst = backups.sort((a, b) => (a.time === b.time ? b.copy - a.copy : a.time < b.time ? 1 : -1));
		const doomed: string[] = [];
		const counted = new Map<string, number>();
		newestFirst.forEach((backup, rank) => {
			const seen = (counted.get(backup.note) ?? 0) + 1;
			counted.set(backup.note, seen);
			const protectedForNote = seen <= Math.min(keep, BACKUPS_KEPT_PER_NOTE);
			if (rank >= keep && !protectedForNote && backup.path !== justWritten) doomed.push(backup.path);
		});
		for (const path of doomed) await adapter.remove(path);
	}
}

/** Content hash recorded in a BackupToken and checked by SafeWriter.replace. Pure. */
export function contentHash(text: string): string {
	return `${text.length.toString(36)}-${fnv1a32(text).toString(16).padStart(8, "0")}`;
}

/**
 * The one place a BackupToken is created. The brand in types.ts is a
 * type-level marker with no runtime value, so this cast is the only way to
 * produce one, and it runs only after the backup was written.
 */
function mintToken(path: string, backupPath: string, hash: string): BackupToken {
	return { path, backupPath, contentHash: hash } as BackupToken;
}

/** Local time as `yyyymmdd-hhmmss`. */
function timestamp(date: Date): string {
	const two = (n: number): string => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
	return `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}
