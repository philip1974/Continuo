// 编辑器 ⌘F 查找面板:匹配计数 / 无结果播报、⌥⌘F 替换(Windows / Linux Ctrl+H)、⌥⌘C 切换大小写、↑ 历史(对齐 VSCode findWidget)。
// BDD: src/__tests__/editor-find-widget/
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const MAC = process.platform === 'darwin';
const REPLACE_KEY = MAC ? 'Meta+Alt+KeyF' : 'Control+KeyH';
const CASE_KEY = MAC ? 'Meta+Alt+KeyC' : 'Alt+KeyC';
const FOO_154 = Array.from({ length: 154 }, (_, i) => `const foo${i} = ${i};`).join('\n') + '\n';

/** 在查找框里像用户一样重新输入(默认面板在 keyup 时提交查询;fill 只发 input 事件)。 */
async function retype(win: Page, text: string): Promise<void> {
  await win.locator('.cm-search [name="search"]').selectText();
  await win.keyboard.type(text);
}

async function openFind(win: Page): Promise<void> {
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+KeyF');
  await expect(win.locator('.cm-search [name="search"]')).toBeFocused();
}

test('查找:计数「当前 / 总数」、无结果标红并播报、⌥⌘F 聚焦替换框、⌥⌘C 切换大小写、↑ 翻历史', async () => {
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-find-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-find-ws-'));
  try {
    writeFileSync(path.join(ws, 'find.ts'), FOO_154);
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await win.locator('text=find.ts').first().click();
      await expect(win.locator('.cm-content')).toBeVisible({ timeout: 10_000 });

      await openFind(win);
      const search = win.locator('.cm-search [name="search"]');
      const count = win.locator('.cm-search .cm-search-count');
      await expect(count).toHaveAttribute('role', 'status');

      // 计数:输入后总数,回车跳到光标后第一个匹配 →「n / 154」,再回车 n+1
      await win.keyboard.type('foo');
      await expect(count).toHaveText(/^154\D/);
      await win.keyboard.press('Enter');
      await expect(count).toHaveText(/^\d+ \/ 154$/);
      const n = Number((await count.textContent())!.split(' ')[0]);
      await win.keyboard.press('Enter');
      await expect(count).toHaveText(`${n + 1} / 154`);

      // 无结果:计数区(live region)显示「无结果」,查找框 aria-invalid
      await retype(win, 'zzz-no-such');
      await expect(count).toHaveText(/^(No results|无结果|결과 없음)$/);
      await expect(search).toHaveAttribute('aria-invalid', 'true');
      await retype(win, 'foo1');
      await expect(search).not.toHaveAttribute('aria-invalid', 'true');
      await win.keyboard.press('Enter');

      // ⌥⌘C(Windows / Linux Alt+C):翻转区分大小写,复选框同步
      const caseBox = win.locator('.cm-search [name="case"]');
      await expect(caseBox).not.toBeChecked();
      await win.keyboard.press(CASE_KEY);
      await expect(caseBox).toBeChecked();
      await win.keyboard.press(CASE_KEY);
      await expect(caseBox).not.toBeChecked();

      // ↑ 历史:先前回车提交过 foo / foo1
      await retype(win, 'foo22');
      await win.keyboard.press('Enter');
      await win.keyboard.press('ArrowUp');
      await expect(search).toHaveValue('foo1');
      await win.keyboard.press('ArrowUp');
      await expect(search).toHaveValue('foo');
      await win.keyboard.press('ArrowDown');
      await expect(search).toHaveValue('foo1');

      // Esc 关闭后在编辑区按 ⌥⌘F(Windows / Linux Ctrl+H):打开面板并聚焦替换框
      await win.keyboard.press('Escape');
      await expect(win.locator('.cm-search')).toHaveCount(0);
      await win.locator('.cm-content').click();
      await win.keyboard.press(REPLACE_KEY);
      await expect(win.locator('.cm-search input[name="replace"]')).toBeFocused();
    } finally {
      await closeDiscardingUnsaved(app);
    }
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
