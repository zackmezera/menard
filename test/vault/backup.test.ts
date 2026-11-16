import { beforeEach, describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { BACKUPS_KEPT_PER_NOTE, VaultBackupStore, contentHash } from "../../src/vault/backup";
import { createFakeApp, type FakeApp } from "./fake-app";
import { SOURCE_PATH, SOURCE_TEXT } from "./fixtures";

const FOLDER = ".config-dir/plugins/menard/backups";

let fake: FakeApp;
let source: TFile;
let clock: Date;
let keep: number;
let store: VaultBackupStore;

beforeEach(() => {
	fake = createFakeApp();
	source = fake.vault.seed(SOURCE_PATH, SOURCE_TEXT);
	clock = new Date(2026, 9, 4, 9, 5, 7);
	keep = 30;
	store = new VaultBackupStore(fake.app, () => keep, ".config-dir/plugins/menard", () => clock);
});

function advance(seconds: number): void {
	clock = new Date(clock.getTime() + seconds * 1000);
}

describe("VaultBackupStore", () => {
	it("keeps backups in the plugin folder under the config directory", () => {
		expect(store.folder).toBe(FOLDER);
	});

	it("keeps backups in the folder the plugin is installed in, whatever its name", () => {
		expect(new VaultBackupStore(fake.app, () => keep, ".config-dir/plugins/menard-beta/").folder).toBe(".config-dir/plugins/menard-beta/backups");
	});

	it("creates the folder and writes a timestamped full copy", async () => {
		const token = await store.save(source);

		expect(fake.vault.adapter.folders.has(FOLDER)).toBe(true);
		expect(token.path).toBe(SOURCE_PATH);
		expect(token.backupPath).toBe(`${FOLDER}/20261004-090507-@ruizalmotasim.md`);
		expect(fake.vault.adapter.files.get(token.backupPath)).toBe(SOURCE_TEXT);
	});

	it("records the hash of the content it saved", async () => {
		const token = await store.save(source);
		expect(token.contentHash).toBe(contentHash(SOURCE_TEXT));
	});

	it("never overwrites a backup made in the same second", async () => {
		const first = await store.save(source);
		fake.vault.edit(source, `${SOURCE_TEXT}Segunda versión.\n`);
		const second = await store.save(source);

		expect(second.backupPath).toBe(`${FOLDER}/20261004-090507-@ruizalmotasim (2).md`);
		expect(fake.vault.adapter.files.get(first.backupPath)).toBe(SOURCE_TEXT);
		expect(fake.vault.adapter.files.get(second.backupPath)).toBe(`${SOURCE_TEXT}Segunda versión.\n`);
	});

	it("prunes to the newest keep() backups and leaves other files alone", async () => {
		keep = 3;
		await fake.vault.adapter.mkdir(FOLDER);
		await fake.vault.adapter.write(`${FOLDER}/LEEME.txt`, "no es una copia");
		const paths: string[] = [];
		for (let i = 0; i < 5; i++) {
			paths.push((await store.save(source)).backupPath);
			advance(61);
		}

		const remaining = [...fake.vault.adapter.files.keys()].sort();
		expect(remaining).toEqual([`${FOLDER}/LEEME.txt`, ...paths.slice(2)].sort());
	});

	it("always keeps the backup it just made", async () => {
		keep = 0;
		const first = await store.save(source);
		advance(1);
		const second = await store.save(source);
		expect([...fake.vault.adapter.files.keys()]).toEqual([second.backupPath]);
		expect(fake.vault.adapter.files.has(first.backupPath)).toBe(false);
	});

	it("counts a numbered copy as newer than the earlier copies of the same second", async () => {
		keep = 2;
		const first = await store.save(source);
		const second = await store.save(source);
		const third = await store.save(source);

		expect(third.backupPath).toBe(`${FOLDER}/20261004-090507-@ruizalmotasim (3).md`);
		expect([...fake.vault.adapter.files.keys()].sort()).toEqual([second.backupPath, third.backupPath].sort());
		expect(fake.vault.adapter.files.has(first.backupPath)).toBe(false);
	});

	it("keeps each note's newest backups when other notes fill the folder (#32)", async () => {
		keep = 5;
		const other = fake.vault.seed("Collections/Texts/@otra.md", "Otra nota.\n");
		const sourceBackups: string[] = [];
		for (let i = 0; i < 4; i++) {
			sourceBackups.push((await store.save(source)).backupPath);
			advance(1);
		}
		const otherBackups: string[] = [];
		for (let i = 0; i < 20; i++) {
			otherBackups.push((await store.save(other)).backupPath);
			advance(1);
		}

		const remaining = new Set(fake.vault.adapter.files.keys());
		const keptForSource = sourceBackups.filter((path) => remaining.has(path));
		expect(keptForSource).toEqual(sourceBackups.slice(-BACKUPS_KEPT_PER_NOTE));
		expect(otherBackups.filter((path) => remaining.has(path))).toEqual(otherBackups.slice(-keep));
		expect(remaining.size).toBe(keep + BACKUPS_KEPT_PER_NOTE);
	});

	it("never keeps more per note than keep() allows in total", async () => {
		keep = 1;
		const other = fake.vault.seed("Collections/Texts/@otra.md", "Otra nota.\n");
		const first = await store.save(source);
		advance(1);
		await store.save(source);
		advance(1);
		const third = await store.save(other);
		expect([...fake.vault.adapter.files.keys()].sort()).toContain(third.backupPath);
		expect(fake.vault.adapter.files.has(first.backupPath)).toBe(false);
	});

	it("prunes nothing when keep() is not a number", async () => {
		const first = await store.save(source);
		advance(1);
		keep = Number.NaN;
		const second = await store.save(source);
		expect([...fake.vault.adapter.files.keys()].sort()).toEqual([first.backupPath, second.backupPath].sort());
	});

	it("reports a failed backup as backup-failed", async () => {
		fake.vault.delete(source);
		await expect(store.save(source)).rejects.toMatchObject({ code: "backup-failed" });
	});
});

describe("contentHash", () => {
	it("is deterministic", () => {
		expect(contentHash(SOURCE_TEXT)).toBe(contentHash(`${SOURCE_TEXT}`));
	});

	it("changes with a single character", () => {
		expect(contentHash("«reseñar»")).not.toBe(contentHash("“reseñar”"));
		expect(contentHash("p. 14")).not.toBe(contentHash("p. 15"));
	});

	it("tells line endings apart", () => {
		expect(contentHash("a\nb")).not.toBe(contentHash("a\r\nb"));
	});

	it("has the form <length in base 36>-<8 hex digits>", () => {
		expect(contentHash("")).toMatch(/^0-[0-9a-f]{8}$/);
		expect(contentHash(SOURCE_TEXT)).toMatch(new RegExp(`^${SOURCE_TEXT.length.toString(36)}-[0-9a-f]{8}$`));
	});
});
