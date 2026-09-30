import browser from 'webextension-polyfill';

import {
  ImportError,
  backupFileName,
  bookmarksFileName,
  buildBackup,
  buildBookmarksHtml,
  parseImportFile,
  serializeBackup,
  summarizeProblems,
  type ImportPlan,
} from '@/lib/backup';
import { DB_VERSION, exportAll, importDump, listAllItems, type MergeOutcome } from '@/lib/library';
import { element, required } from '@/ui/shared/dom';

import { numbers, type Page } from './page';

const REVOKE_MS = 60_000;

async function downloadFile(content: string, fileName: string, mime: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));

  try {
    await browser.downloads.download({ url, filename: fileName, saveAs: true });
  } catch (error) {
    console.warn('[savely] downloads API unavailable, falling back to a link:', error);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, REVOKE_MS);
  }
}

function reportLine(text: string): HTMLParagraphElement {
  return element('p', 'report__line', text);
}

export function mountTransfer(page: Page): void {
  const exportJsonButton = required<HTMLButtonElement>('#export-json');
  const exportHtmlButton = required<HTMLButtonElement>('#export-html');
  const input = required<HTMLInputElement>('#import-file');
  const report = required<HTMLDivElement>('#report');

  async function exportJson(): Promise<void> {
    const now = Date.now();
    const dump = await exportAll();
    await downloadFile(
      serializeBackup(buildBackup(dump, DB_VERSION, now)),
      backupFileName(now),
      'application/json',
    );
    page.toast(`Backup ready: ${numbers.format(dump.items.length)} items.`);
  }

  async function exportBookmarks(): Promise<void> {
    const now = Date.now();
    const items = await listAllItems();
    await downloadFile(buildBookmarksHtml(items, now), bookmarksFileName(now), 'text/html');
    page.toast(`Bookmarks ready: ${numbers.format(items.length)} items.`);
  }

  function renderImportError(message: string): void {
    report.className = 'report report--error';
    report.replaceChildren(reportLine(`Nothing was imported: ${message}`));
    report.hidden = false;
  }

  function renderReport(fileName: string, plan: ImportPlan, outcome: MergeOutcome): void {
    const source = plan.source === 'json' ? 'a Savely backup' : 'a Pocket export';
    const skipped = plan.problems.length + outcome.skipped;

    report.className = 'report';
    report.replaceChildren(
      reportLine(`${fileName} — ${source}, ${numbers.format(plan.total)} records in the file.`),
      reportLine(
        `Added ${numbers.format(outcome.added)} new items, merged ${numbers.format(outcome.merged)} existing ones.`,
      ),
      reportLine(
        `Content: ${numbers.format(outcome.contents)}, highlights: ${numbers.format(outcome.highlights)}.`,
      ),
    );

    if (skipped === 0) {
      report.append(reportLine('Nothing was skipped.'));
    } else {
      report.append(reportLine(`Skipped ${numbers.format(skipped)} records:`));

      const list = element('ul', 'report__problems');
      for (const group of summarizeProblems(plan.problems)) {
        list.append(
          element(
            'li',
            '',
            `${group.reason} — ${numbers.format(group.count)} (${group.examples.join(', ')})`,
          ),
        );
      }
      if (outcome.skipped > 0) {
        list.append(
          element(
            'li',
            '',
            `content and highlights already in the database — ${numbers.format(outcome.skipped)}`,
          ),
        );
      }
      report.append(list);
    }

    report.hidden = false;
  }

  async function importFile(file: File): Promise<void> {
    let plan: ImportPlan;
    try {
      plan = parseImportFile(file.name, await file.text());
    } catch (error) {
      renderImportError(
        error instanceof ImportError ? error.message : 'the file could not be read.',
      );
      return;
    }

    if (plan.dump.items.length === 0) {
      renderImportError('it contains no item that could be saved.');
      return;
    }

    const outcome = await importDump(plan.dump);
    renderReport(file.name, plan, outcome);
    page.toast(`Imported ${numbers.format(outcome.added + outcome.merged)} items.`);
    await page.refresh();
  }

  exportJsonButton.addEventListener('click', () => {
    void exportJson().catch((error: unknown) => {
      console.error('[savely] JSON export failed:', error);
      page.toast('Could not prepare the backup.');
    });
  });

  exportHtmlButton.addEventListener('click', () => {
    void exportBookmarks().catch((error: unknown) => {
      console.error('[savely] bookmarks export failed:', error);
      page.toast('Could not prepare the bookmarks.');
    });
  });

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file === undefined) return;

    void importFile(file)
      .catch((error: unknown) => {
        console.error('[savely] import failed:', error);
        renderImportError('writing to the database failed, the database is unchanged.');
      })
      .finally(() => {
        input.value = '';
      });
  });
}
