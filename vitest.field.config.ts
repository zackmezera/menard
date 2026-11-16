import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `npm run field`: the private regression check against the real claude CLI. Never part of `npm test`. */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./test/__mocks__/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/field/**/*.field.ts"],
		// The CLI backend runs as it does in Obsidian, with a window.
		environment: "happy-dom",
		testTimeout: 3_600_000,
	},
});
