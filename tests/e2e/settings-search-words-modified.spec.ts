// 设置搜索按词匹配 / 关键词别名 / @modified + 已修改指示条 / 非整数设置的步长 / 终端设置旧 id 迁移(对齐 VSCode)。
// BDD: src/__tests__/settings-panel/ · setting-item-row/ · settings-values/
import { expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from './fixtures/electron-app';
import { launchContinuo } from './helpers/launch';
import { waitForTestHooks } from './helpers/app-ready';
import { readUserSettingsFile, removeUserSettingsFiles } from './helpers/user-settings-file';
import { MATCHED_SETTINGS, openSettings, settingsSearch } from './helpers/settings';

const chip = (window: import('@playwright/test').Page, id: string) =>
  window.locator('main code').filter({ hasText: new RegExp(`^${id.replace(/\./g, '\\.')}$`) });

// 只在关键词里出现的同义说法(标题是「字号 / Font size / 글꼴 크기」)。
const FONT_SIZE_KEYWORD: Record<string, string> = { 'zh-CN': '字体大小', en: 'text size', ko: '글자 크기' };

test('多个词按 AND 匹配(词序无关)+ 关键词别名', async ({ window }) => {
  await openSettings(window);
  const search = settingsSearch(window);
  for (const q of ['editor font', 'font editor']) {
    await search.fill(q);
    await expect(chip(window, 'editor.fontSize')).toBeVisible();
    await expect(chip(window, 'terminal.integrated.fontSize')).toHaveCount(0);
  }
  const lang = await window.evaluate(() => document.documentElement.lang);
  await search.fill(FONT_SIZE_KEYWORD[lang] ?? 'text size');
  await expect(chip(window, 'editor.fontSize')).toBeVisible();
  await expect(chip(window, 'terminal.integrated.fontSize')).toBeVisible();
});

test('@modified 只列已修改项,行左侧有已修改指示条', async ({ window }) => {
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.fontSize', 16));
  await openSettings(window);
  await settingsSearch(window).fill('@modified');
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible();
  const row = window.locator('[data-setting-row="editor.fontSize"]');
  await expect(row).toBeVisible();
  await expect(window.locator('[data-setting-row="terminal.integrated.fontSize"]')).toHaveCount(0);
  const bar = row.getByTestId('setting-modified-indicator');
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  const rowBox = await row.boundingBox();
  // 竖条在行内容左侧(内边距里),高度覆盖行主体
  expect(box!.x).toBeLessThan(rowBox!.x);
  expect(box!.height).toBeGreaterThan(10);
  const color = await bar.evaluate((el) => getComputedStyle(el).borderLeftColor);
  expect(color).not.toBe('rgba(0, 0, 0, 0)');
});

test('editor.lineHeight 从默认 0 按 ↑ 一次得 1(不是 0.1)', async ({ window }) => {
  await waitForTestHooks(window);
  await openSettings(window);
  await settingsSearch(window).fill('@id:editor.lineHeight');
  const input = window.locator('[data-setting-row="editor.lineHeight"] input');
  await expect(input).toHaveValue('0');
  await input.focus();
  await window.keyboard.press('ArrowUp');
  await expect(input).toHaveValue('1');
  expect(await window.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.lineHeight'))).toBe(1);
});

test('旧 id terminal.fontSize / terminal.cursorStyle 的已存值重启后迁到 terminal.integrated.*', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-settings-migrate-'));
  try {
    const app1 = await launchContinuo(ud);
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win1);
    // 旧版本存在 localStorage(主进程文件还不存在):首次启动新版本时迁入,旧 id 一并改名
    await win1.evaluate(() =>
      localStorage.setItem(
        'continuo.settings.values',
        JSON.stringify({ 'terminal.fontSize': 18, 'terminal.cursorStyle': 'bar' }),
      ),
    );
    await app1.close();
    removeUserSettingsFiles(ud);

    const app2 = await launchContinuo(ud);
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    await waitForTestHooks(win2);
    const got = await win2.evaluate(() => ({
      fontSize: globalThis.__continuoTest!.getSettingValue('terminal.integrated.fontSize'),
      cursorStyle: globalThis.__continuoTest!.getSettingValue('terminal.integrated.cursorStyle'),
    }));
    expect(got.fontSize).toBe(18);
    expect(got.cursorStyle).toBe('bar');
    await expect
      .poll(() => readUserSettingsFile(ud))
      .toEqual({ 'terminal.integrated.fontSize': 18, 'terminal.integrated.cursorStyle': 'bar' });
    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
