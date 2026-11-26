// 键盘从资源管理器「更多操作」→「最近打开」切换文件夹后,焦点交给新 root 的文件树(VSCode:切换文件夹后焦点在资源管理器)。
// 此前触发按钮随 root 变化卸载,300ms 内焦点落到 BODY 并一直停在那里。BDD: src/__tests__/explorer-commands/(§4)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerMoreActionsButton, explorerSidebar } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady } from './helpers/app-ready';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 焦点所在:BODY / 文件树(treeitem 或 tree)/ 其它。 */
const focusWhere = (win: Page): Promise<string> =>
  win.evaluate(() => {
    const a = document.activeElement;
    if (a === null || a === document.body) return 'BODY';
    if (a.closest('[role=tree]') !== null) return 'tree';
    return `${a.tagName}:${a.getAttribute('role') ?? ''}:${(a.textContent ?? '').slice(0, 30)}`;
  });

test('键盘:更多操作 → 方向键选最近目录 → 回车,焦点落在新 root 的文件树并保持', async () => {
  test.setTimeout(90_000);
  const ud = tempDir('ui98b-ud-');
  const ws1 = tempDir('ui98b-ws1-');
  const ws3 = tempDir('ui98b-ws3-');
  writeFileSync(path.join(ws1, 'one.txt'), '1\n');
  writeFileSync(path.join(ws3, 'three.txt'), '3\n');
  seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws3] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await expect(explorerSidebar(win)).toContainText('one.txt', { timeout: 15_000 });

  await explorerMoreActionsButton(win).focus();
  await win.keyboard.press('Enter');
  const target = path.basename(ws3);
  let found = false;
  for (let i = 0; i < 12 && !found; i++) {
    await win.keyboard.press('ArrowDown');
    found = await win.evaluate((name) => (document.activeElement?.textContent ?? '').includes(name), target);
  }
  expect(found).toBe(true);
  await win.keyboard.press('Enter');

  await expect(explorerSidebar(win)).toContainText('three.txt', { timeout: 10_000 });
  await expect.poll(() => focusWhere(win), { timeout: 10_000 }).toBe('tree');
  await win.waitForTimeout(800);
  expect(await focusWhere(win)).toBe('tree');
  // 焦点行属于新 root(方向键可直接在新树里移动)。读 activeElement:CSS :focus 只在窗口真实获焦时匹配
  expect(
    await win.evaluate(() => {
      const a = document.activeElement;
      return a?.getAttribute('role') === 'treeitem' ? (a.textContent ?? '') : null;
    }),
  ).toContain('three.txt');
});
