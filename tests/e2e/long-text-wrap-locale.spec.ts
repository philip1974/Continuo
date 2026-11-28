// 长路径 / 长文件名(无空格)在韩 / 中 / 英界面下折行,不撑破授权弹窗、toast、确认框(韩文 keep-all 此前未分层,压过 break-all;
// BDD: src/__tests__/long-text-wrap/)。量真实排版:容器 scrollWidth ≤ clientWidth,且所有子元素右缘不超出容器。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { openTreeItem } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { PERMISSION_DENY_ALL } from './helpers/permission-prompt';
import { seedExplorerJson } from './helpers/seed-explorer';

const CANCEL = /^(Cancel|取消|취소)$/;
const LONG = 'averylongfilenamewithoutanybreakopportunity'.repeat(4);
const BINARY = `${LONG}.dat`;
const READONLY = `${LONG}.ts`;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(path.join(dir, READONLY), 0o644);
    } catch {
      // 不是工作区目录
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 容器横向溢出量:scrollWidth − clientWidth 与子元素右缘超出容器右缘(含边框内)的最大值,单位 px。 */
const overflowOf = (container: Locator) =>
  container.evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    let max = el.scrollWidth - el.clientWidth;
    for (const child of el.querySelectorAll('*')) max = Math.max(max, child.getBoundingClientRect().right - right);
    return max;
  });

test.skip(process.platform === 'win32', 'chmod 444 在 Windows 只映射只读属性');

for (const locale of ['ko', 'zh', 'en'] as const) {
  test(`${locale}:授权弹窗 / toast / 确认框里的长文件名折行,不越出容器`, async () => {
    test.setTimeout(90_000);
    const ud = mkdtempSync(path.join(tmpdir(), 'ui182-ud-'));
    const ws = mkdtempSync(path.join(tmpdir(), 'ui182-ws-'));
    dirs.push(ud, ws);
    writeFileSync(path.join(ws, BINARY), Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 0x80, 0x81]));
    writeFileSync(path.join(ws, READONLY), 'export const a = 1;\n');
    seedExplorerJson(ud, { root: ws });
    const app = await launchContinuo(ud);
    apps.push(app);
    const win: Page = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
    await win.evaluate((v) => globalThis.__continuoTest!.setSettingValue('general.language', v), locale);
    await expect.poll(() => win.evaluate(() => document.documentElement.lang)).toBe(locale === 'zh' ? 'zh-CN' : locale);

    // 1. 插件授权弹窗:插件 id(UntrustedText)。不超过截断上限 80(省略号「…」本身是断行点,截断后的两半各自放得下)
    await win.evaluate((id) => void globalThis.__continuoTest!.requestPermissions(id, ['fs']), `co.${LONG.slice(0, 75)}`);
    const modal = win.locator('.wm-modal-content');
    await expect(modal).toBeVisible();
    expect(await overflowOf(modal)).toBeLessThanOrEqual(1);
    await modal.getByRole('button', { name: PERMISSION_DENY_ALL }).click();
    await expect(modal).toHaveCount(0);

    // 2. toast:打开二进制长文件名失败
    await openTreeItem(win, BINARY);
    const toast = win.locator('.toast[data-level="error"]').filter({ hasText: BINARY });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    expect(await overflowOf(toast)).toBeLessThanOrEqual(1);
    // 韩文正文仍按词断行(继承根元素 keep-all);确认框说明区同
    const wordBreak = (l: Locator) => l.evaluate((el) => getComputedStyle(el).wordBreak);
    expect(await wordBreak(toast.locator('.toast__message'))).toBe(locale === 'ko' ? 'keep-all' : 'normal');

    // 3. 写保护文件 ⌘S → 确认框(标题 / 说明含长文件名)
    await openTreeItem(win, READONLY);
    const editor = win.locator('.cm-content').first();
    await expect(editor).toContainText('export const a');
    chmodSync(path.join(ws, READONLY), 0o444);
    await editor.click();
    await win.keyboard.press('ControlOrMeta+End');
    await win.keyboard.type('\n// edit');
    await win.keyboard.press('ControlOrMeta+s');
    const dialog = win.getByRole('alertdialog');
    await expect(dialog).toContainText(LONG, { timeout: 5_000 });
    expect(await overflowOf(dialog)).toBeLessThanOrEqual(1);
    expect(await wordBreak(dialog.locator('h2'))).toBe(locale === 'ko' ? 'keep-all' : 'normal');
    await dialog.getByRole('button', { name: CANCEL }).click();
    await expect(dialog).toHaveCount(0);
  });
}
