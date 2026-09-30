import browser from 'webextension-polyfill';

import { onDataChanged } from '@/lib/changes';
import { clearAllData, dataStats } from '@/lib/library';
import { isTheme, type Theme } from '@/lib/settings';
import { initTheme, setTheme } from '@/lib/theme';
import { required } from '@/ui/shared/dom';
import { showToast } from '@/ui/shared/toast';

import { mountBackups } from './backups-panel';
import { createConfirm } from './confirm';
import { numbers, type Page, type Section } from './page';
import { mountStats } from './stats-panel';
import { mountSync } from './sync-panel';
import { mountTransfer } from './transfer-panel';

const toastEl = required<HTMLDivElement>('#toast');
const themeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];

const sections: Section[] = [];

const page: Page = {
  toast(message) {
    showToast(toastEl, { message });
  },
  ask: createConfirm(),
  async refresh() {
    for (const section of sections) await section.refresh();
  },
};

async function wipe(): Promise<void> {
  const stats = await dataStats();
  const ok = await page.ask(
    'Delete all data?',
    `${numbers.format(stats.items)} items, ${numbers.format(stats.contents)} stored articles, ${numbers.format(stats.highlights)} highlights and every automatic backup will be gone. This cannot be undone.`,
  );
  if (!ok) return;

  await clearAllData();
  page.toast('The database has been cleared.');
  await page.refresh();
}

function showTheme(theme: Theme): void {
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset['themeChoice'] === theme));
  }
}

function wireThemes(): void {
  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      const choice = button.dataset['themeChoice'];
      if (!isTheme(choice)) return;
      showTheme(choice);
      void setTheme(choice);
    });
  }
}

async function main(): Promise<void> {
  sections.push(mountStats(), mountSync(page), mountBackups(page));
  mountTransfer(page);

  required<HTMLButtonElement>('#open-list').addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('ui/list/list.html?full=1') });
  });
  required<HTMLButtonElement>('#wipe').addEventListener('click', () => {
    void wipe();
  });
  wireThemes();

  onDataChanged(() => {
    void page.refresh();
  });
  void initTheme(showTheme);
  await page.refresh();
}

void main();
