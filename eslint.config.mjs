import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
	globalIgnores(["main.js", "node_modules/", "coverage/", "scripts/"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.ts", "vitest.field.config.ts"],
				},
			},
		},
	},
	{
		// EPUB is a format name, like PDF.
		rules: { "obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, acronyms: [...DEFAULT_ACRONYMS, "EPUB"] }] },
	},
	{
		// Pure modules (docs/DESIGN.md §3): no runtime dependency on Obsidian, the DOM or Node.
		files: [
			"src/text/**/*.ts",
			"src/align/**/*.ts",
			"src/llm/envelope.ts",
			"src/llm/protect.ts",
			"src/llm/prompts.ts",
			"src/llm/validate.ts",
			"src/jobs/skeleton.ts",
			"src/jobs/assemble.ts",
			"src/jobs/split-plan.ts",
			"src/reader/cursor.ts",
			"src/reader/geometry.ts",
			"src/vault/properties.ts",
			"src/diagnose/report.ts",
			"src/types.ts",
			"src/constants.ts",
			"src/errors.ts",
			"src/settings.ts",
			"src/import/zip.ts",
			"src/import/epub.ts",
			"src/import/pages.ts",
			"src/import/pdf.ts",
		],
		rules: {
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					paths: [
						{ name: "obsidian", message: "Pure module: import types only.", allowTypeImports: true },
						{ name: "@codemirror/state", message: "Pure module.", allowTypeImports: true },
						{ name: "@codemirror/view", message: "Pure module.", allowTypeImports: true },
					],
				},
			],
		},
	},
	{
		// Build and test tooling runs in Node, not inside Obsidian.
		files: ["*.mjs", "vitest.config.ts", "test/**/*.ts"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"import/no-nodejs-modules": "off",
		},
	},
	{
		// Tests run in Node or happy-dom, never in an Obsidian window.
		files: ["test/**/*.ts"],
		rules: {
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/prefer-create-el": "off",
		},
	},
]);
