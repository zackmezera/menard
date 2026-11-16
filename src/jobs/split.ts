/**
 * Executes a split plan: backup, create, replace, link, then align.
 * Owner: jobs module. DESIGN.md §7.3.
 */
import type { TFile } from "obsidian";
import { FM } from "../constants";
import { parseOptions } from "../settings";
import { parseNote, textUnits } from "../text/blocks";
import { parseNewNoteProperties, translationPath, wikilinkValue } from "../vault/properties";
import { runAlign } from "./align";
import type { JobDeps } from "./controller";
import { uiOf } from "./modals";
import { messageFor } from "./progress";
import { frontmatterBlock, newNoteFrontmatter } from "./skeleton";
import { sameLanguage } from "./language";
import { planSplit } from "./split-plan";
import { guessUnitsLanguage, linkPair, linkedNote, proposedLanguages, requireClaude, sameLanguageMessage } from "./translate";

const TITLE = "Split into source and translation notes";

export async function runSplit(deps: JobDeps, file: TFile, controller: AbortController): Promise<void> {
	const ui = uiOf(deps);
	const settings = deps.ctx.settings();
	const { app } = deps.ctx;
	if (!(await requireClaude(deps, ui))) return;

	if (linkedNote(deps, file, FM.translation) !== null || linkedNote(deps, file, FM.source) !== null) {
		ui.explain(TITLE, "This note is already part of a pair, so it cannot be split. Run Check alignment instead.");
		return;
	}
	const original = await app.vault.read(file);
	const result = planSplit(original, settings.translationHeading, parseOptions(settings));
	if (!result.ok) {
		ui.explain(TITLE, result.reason);
		return;
	}
	const { plan } = result;
	const proposed = proposedLanguages(deps, file, settings);
	const exists = (target: string): string | null => {
		const path = translationPath(file.path, target);
		return app.vault.getFileByPath(path) === null ? null : `“${path}” already exists. Rename or remove it, or run Align with existing translation instead.`;
	};
	const existing = exists(proposed.target);
	if (existing !== null) {
		ui.explain(TITLE, existing);
		return;
	}
	const options = parseOptions(settings);
	const guessedSource = guessUnitsLanguage(textUnits(parseNote(plan.sourceText, options)));
	const guessedTarget = guessUnitsLanguage(textUnits(parseNote(plan.translationBody, { textStartHeading: "", skipHeadings: options.skipHeadings })));
	const languages = await ui.confirmSplit({
		plan,
		languages: proposed,
		translationPath: (target) => translationPath(file.path, target),
		...(guessedSource !== undefined ? { guessedSource } : {}),
		...(guessedTarget !== undefined ? { guessedTarget } : {}),
	});
	if (languages === null) return;
	if (sameLanguage(languages.source, languages.target)) {
		ui.explain(TITLE, sameLanguageMessage(languages.source));
		return;
	}
	const path = translationPath(file.path, languages.target);
	const taken = languages.target === proposed.target ? null : exists(languages.target);
	if (taken !== null) {
		ui.explain(TITLE, taken);
		return;
	}

	const backup = await deps.backups.save(file);
	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	const frontmatter = frontmatterBlock(
		newNoteFrontmatter(
			wikilinkValue(app.metadataCache.fileToLinktext(file, path)),
			languages,
			parseNewNoteProperties(settings.newNoteProperties),
		),
		eol,
	);
	const content = frontmatter + plan.translationBody;
	const created = await deps.writer.create(path, content);
	if ((await app.vault.read(created)) !== content) {
		await deps.writer.trashCreated(created);
		ui.explain(TITLE, "The new translation note could not be read back as written, so it was moved to the trash and nothing else changed.");
		return;
	}

	const outcome = await deps.writer.replace(file, backup, (text) =>
		text === original ? [{ from: 0, to: text.length, expect: original, text: plan.sourceText }] : "conflict",
	);
	if (!outcome.ok) {
		await deps.writer.trashCreated(created);
		ui.explain(TITLE, `${messageFor(outcome.error)} The new note was moved to the trash; the original is unchanged.`);
		return;
	}
	await linkPair(deps, file, created);
	await runAlign(deps, file, created, controller);
}
