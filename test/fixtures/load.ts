/** Fixture loaders shared by every module's tests. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A committed synthetic or public-domain fixture from test/fixtures/. */
export function fixture(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

/** A local-only fixture from the gitignored test/fixtures/private/, or null when absent. */
export function privateFixture(name: string): string | null {
	const path = fileURLToPath(new URL(`./private/${name}`, import.meta.url));
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}
