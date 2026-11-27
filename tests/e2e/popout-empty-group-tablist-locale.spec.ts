// 有 popout 子窗时主窗留下的空 dock 占位组(组内无 tab,SharedTab 不渲染):其 tab 条 tablist 名称切换语言后随之更新
//(组级 HeaderActions 负责;BDD: src/__tests__/popout-header-menu/)。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 主窗所有 tab 条:名称 + 内含 tab 数。 */
const strips = (win: Page) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.dv-tabs-container')].map((el) => ({
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      tabs: el.querySelectorAll('[role=tab]').length,
    })),
  );

/** 同设置页改「语言」(general.language → main 持久化并广播 locale 变化)。 */
const setLocale = (win: Page, locale: string) =>
  win.evaluate((v) => globalThis.__continuoTest!.setSettingValue('general.language', v), locale);

test('主窗唯一组整组弹出后,主窗空占位组的 tablist 名称随语言切换更新', async () => {
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui114-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui114-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);

  // 主窗唯一 dock 组(编辑器)整组弹出 → 主窗网格里留下无 tab 的占位组
  const tab = win.locator('.dv-tab').first();
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click();
  await tab
    .locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')
    .getByRole('button', { name: DOCK_POPOUT })
    .click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });

  await expect.poll(async () => (await strips(win)).some((s) => s.tabs === 0), { timeout: 10_000 }).toBe(true);
  await setLocale(win, 'en');
  await expect
    .poll(async () => (await strips(win)).filter((s) => s.tabs === 0).map((s) => [s.role, s.label]), { timeout: 10_000 })
    .toEqual(expect.arrayContaining([['tablist', 'Panel tabs']]));
  await setLocale(win, 'zh');
  await expect
    .poll(async () => (await strips(win)).filter((s) => s.tabs === 0).every((s) => s.role === 'tablist' && s.label === '面板标签'), {
      timeout: 10_000,
    })
    .toBe(true);
});
