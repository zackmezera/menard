// @vitest-environment happy-dom
import { EditorSelection, EditorState, type StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, type MarkdownFileInfo } from "obsidian";
import { describe, expect, it } from "vitest";
import { hiddenRanges, livePreviewExtension } from "../../src/render/live-preview";
import { FakePairs, fakeApp, fakeContext, fileAt, SOURCE_PATH } from "./fakes";

const both = { hideIds: true, hideMaps: true };

function hidden(doc: string, selections: { from: number; to: number }[] = [], options = both): string[] {
	return hiddenRanges(doc, selections, options).map((r) => `${r.block ? "block" : "inline"}:${JSON.stringify(doc.slice(r.from, r.to))}`);
}

const NOTE = [
	"---",
	'source: "[[@cervantes]]"',
	"---",
	"Según el Sr. Pérez, J. L. Borges leyó a Poe. ^p1",
	"",
	"%%menard:1 p1 9.abcd/8.efgh%%",
	"",
	"> Primer verso,",
	"> segundo verso.",
	"",
	"^p2",
	"",
	"Una nota mía. ^intro-1",
	"",
	"Un párrafo con %%p. 2%% comentario. ^p3",
].join("\n");

describe("hiddenRanges", () => {
	it("leaves a Menard line with trailing whitespace alone, as every module does (#35)", () => {
		expect(hidden("Texto. ^p1\n\n%%menard:1 p1 align%% \n", [], { hideIds: false, hideMaps: true })).toEqual([]);
	});

	it("does not hide a Menard-looking line inside a user's %% block as a map (#35)", () => {
		expect(hidden("%%\nnotas\n%%menard:1 p1 align%%\n%%\n", [], { hideIds: false, hideMaps: true })).toEqual([]);
	});

	it("hides trailing ids, own-line ids and Menard lines", () => {
		expect(hidden(NOTE)).toEqual(['inline:" ^p1"', 'block:"%%menard:1 p1 9.abcd/8.efgh%%"', 'block:"^p2"', 'inline:" ^p3"']);
	});

	it("never hides a user's own id or comment", () => {
		const doc = "Texto. ^intro-1\n\n%% nota personal: ^p9 %%\n\n%%\n^p4\n%%menard:1 p4 align%%\n%%\n\n^cap-2";
		expect(hidden(doc)).toEqual([]);
	});

	it("honours each toggle on its own", () => {
		expect(hidden(NOTE, [], { hideIds: true, hideMaps: false })).toEqual(['inline:" ^p1"', 'block:"^p2"', 'inline:" ^p3"']);
		expect(hidden(NOTE, [], { hideIds: false, hideMaps: true })).toEqual(['block:"%%menard:1 p1 9.abcd/8.efgh%%"']);
		expect(hidden(NOTE, [], { hideIds: false, hideMaps: false })).toEqual([]);
	});

	it("leaves lines a selection touches visible", () => {
		const cursor = NOTE.indexOf("Poe.");
		expect(hidden(NOTE, [{ from: cursor, to: cursor }])).not.toContain('inline:" ^p1"');
		const mapLine = NOTE.indexOf("%%menard");
		// A selection ending exactly at the start of the map line touches it.
		expect(hidden(NOTE, [{ from: mapLine - 1, to: mapLine }])).toEqual(['inline:" ^p1"', 'block:"^p2"', 'inline:" ^p3"']);
		// A selection spanning several lines touches all of them.
		expect(hidden(NOTE, [{ from: 0, to: NOTE.indexOf("^p2") }])).toEqual(['inline:" ^p3"']);
	});

	it("never hides inside fenced code", () => {
		const doc = "```markdown\nEjemplo. ^p1\n%%menard:1 p1 1.aaaa/1.bbbb%%\n^p2\n```\n\n~~~~\n^p5\n~~~\n~~~~\nFuera. ^p3";
		expect(hidden(doc)).toEqual(['inline:" ^p3"']);
	});

	it("treats a fence inside a comment block as comment text", () => {
		const doc = "%%\nBorrador:\n```\n%%\n\nFuera. ^p3\n\n%%menard:1 p3 2.aaaa/2.bbbb%%";
		expect(hidden(doc)).toEqual(['inline:" ^p3"', 'block:"%%menard:1 p3 2.aaaa/2.bbbb%%"']);
	});

	it("ignores the frontmatter and CRLF line endings", () => {
		const doc = "---\nid: ^p1\n---\nTexto. ^p1\r\n\r\n%%menard:1 p1 2.aaaa/2.bbbb%%\r\n";
		expect(hidden(doc)).toEqual(['inline:" ^p1"', 'block:"%%menard:1 p1 2.aaaa/2.bbbb%%"']);
	});

	it("does not take a malformed Menard-looking line for a Menard line", () => {
		expect(hidden("%%menard:1 p1 1.aaaa/1.bbbb%% y algo más")).toEqual([]);
	});
});

describe("livePreviewExtension", () => {
	function state(options: { livePreview?: boolean; path?: string; doc?: string; cursor?: number; settings?: { hideBlockIds?: boolean; hideSentenceMaps?: boolean } } = {}) {
		const ctx = fakeContext(fakeApp().app, options.settings);
		const field = livePreviewExtension(ctx, new FakePairs(null)) as StateField<DecorationSet>;
		const s = EditorState.create({
			doc: options.doc ?? NOTE,
			selection: EditorSelection.cursor(options.cursor ?? 0),
			extensions: [
				editorLivePreviewField.init(() => options.livePreview ?? true),
				editorInfoField.init(() => ({ file: fileAt(options.path ?? SOURCE_PATH) }) as unknown as MarkdownFileInfo),
				field,
			],
		});
		return { s, field };
	}

	function decorations(s: EditorState, field: StateField<DecorationSet>): string[] {
		const out: string[] = [];
		s.field(field).between(0, s.doc.length, (from, to, value) => {
			out.push(`${(value.spec as { block?: boolean }).block ? "block" : "inline"}:${s.doc.sliceString(from, to)}`);
		});
		return out;
	}

	it("decorates a pair note in Live Preview", () => {
		const { s, field } = state();
		expect(decorations(s, field)).toEqual(["inline: ^p1", "block:%%menard:1 p1 9.abcd/8.efgh%%", "block:^p2", "inline: ^p3"]);
	});

	it("does nothing in source mode or on other notes", () => {
		const source = state({ livePreview: false });
		expect(decorations(source.s, source.field)).toEqual([]);
		const other = state({ path: "Notas/diario.md" });
		expect(decorations(other.s, other.field)).toEqual([]);
	});

	it("reads the toggles from settings", () => {
		const { s, field } = state({ settings: { hideBlockIds: false } });
		expect(decorations(s, field)).toEqual(["block:%%menard:1 p1 9.abcd/8.efgh%%"]);
	});

	it("recomputes when the selection moves and when the document changes", () => {
		const { s, field } = state();
		const moved = s.update({ selection: EditorSelection.cursor(NOTE.indexOf("Poe.")) }).state;
		expect(decorations(moved, field)).not.toContain("inline: ^p1");
		const edited = moved.update({ changes: { from: moved.doc.length, insert: "\n\nNuevo. ^p4" } }).state;
		expect(decorations(edited, field)).toContain("inline: ^p4");
	});
});
