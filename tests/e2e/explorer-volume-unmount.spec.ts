// 工作区根是可移动卷(dmg):编辑 README.md(自动保存)→ hdiutil detach → tab 显示「(已删除)」、继续输入有一次「自动保存已暂停」提示、
// 资源管理器显示根读取失败(不是卸载前的过期列表)→ 挂回 → 「(已删除)」清除、资源管理器恢复列表、继续输入自动保存写盘。
// 卷挂在**已有的固定目录**上(卸载后挂载点目录还在):卸载后获焦 → 资源管理器不再列旧文件;挂回后获焦 → 列出卷内容,之后外部新建的
// 文件照常出现(watcher 已重建)。
// BDD: src/__tests__/editor-orphaned-tab/(orphaned-recheck / autosave-paused-notice / root-presence-main)、
// src/__tests__/explorer-root-unavailable/
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { editorTab, openWorkspaceFile } from './helpers/editor';
import { explorerTreeItem } from './helpers/explorer';

test.skip(process.platform !== 'darwin', 'hdiutil 仅 macOS');
// hdiutil create / attach / detach 在负载下要几秒,夹具计入用例超时。
test.describe.configure({ timeout: 90_000 });

const DELETED = /[(（](Deleted|已删除|삭제됨)[)）]/;
const ROOT_UNREADABLE = /(Unable to read this folder|无法读取此文件夹|이 폴더를 읽을 수 없습니다)/;
const PAUSED = /(Auto-save paused|自动保存已暂停|자동 저장 일시 중지)/;

let dmg = '';
let mnt = '';
const attach = () => execFileSync('hdiutil', ['attach', dmg, '-mountpoint', mnt, '-nobrowse'], { stdio: 'ignore' });
const detach = () => execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ui121b-vol-'));
    dmg = path.join(scratch, 'v.dmg');
    mnt = path.join(scratch, 'mnt');
    execFileSync('hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'UIVOL', '-layout', 'NONE', dmg], {
      stdio: 'ignore',
    });
    attach();
    try {
      await writeFile(path.join(mnt, 'README.md'), '# Vol\n');
      await writeFile(path.join(mnt, 'other.txt'), 'other\n');
      await use(mnt);
    } finally {
      try {
        detach();
      } catch {
        /* 已卸载 */
      }
      await rm(scratch, { recursive: true, force: true });
    }
  },
});

async function setContent(window: Page, content: string): Promise<void> {
  const tabId = await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());
  await window.evaluate(
    ({ tabId, content }) => globalThis.__continuoTest!.setEditorContent(tabId as string, content),
    { tabId, content },
  );
}

test('卷卸载再挂回:已删除标记清除、自动保存恢复;卸载期间资源管理器显示根不可用', async ({ window, workspaceRoot }) => {
  const readmePath = path.join(workspaceRoot, 'README.md');
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('autoSave.delayMs', 50));
  await openWorkspaceFile(window, ['README.md']);
  const tab = editorTab(window, /README\.md/);

  await setContent(window, '# Vol\n\nbefore unmount\n');
  await expect.poll(() => readFile(readmePath, 'utf8'), { timeout: 5_000 }).toContain('before unmount');
  await expect(explorerTreeItem(window, /^other\.txt$/)).toBeVisible();

  detach();
  // 资源管理器:根读取失败提示取代过期列表
  await expect(window.getByText(ROOT_UNREADABLE).first()).toBeVisible({ timeout: 15_000 });
  await expect(explorerTreeItem(window, /^other\.txt$/)).toHaveCount(0);

  // 卸载期间继续输入:自动保存不写回 → tab 标「(已删除)」,提示一次「自动保存已暂停」
  await setContent(window, '# Vol\n\nwhile unmounted\n');
  await expect(tab).toContainText(DELETED, { timeout: 15_000 });
  await expect(window.getByText(PAUSED).first()).toBeVisible({ timeout: 5_000 });

  attach();
  await expect(tab).not.toContainText(DELETED, { timeout: 15_000 });
  await expect(explorerTreeItem(window, /^other\.txt$/)).toBeVisible({ timeout: 15_000 });

  // 自动保存恢复:继续输入后写盘
  await setContent(window, '# Vol\n\nafter remount\n');
  await expect.poll(() => readFile(readmePath, 'utf8'), { timeout: 10_000 }).toContain('after remount');
});

test.describe('固定挂载点(卸载后挂载点目录仍在)', () => {
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
    workspaceRoot: async ({}, use) => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'ui127a-fixmp-'));
      dmg = path.join(scratch, 'v.dmg');
      mnt = path.join(scratch, 'mnt');
      await mkdir(mnt); // 事先存在的目录:hdiutil 卸载后不删它
      execFileSync('hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'UIFIX', '-layout', 'NONE', dmg], {
        stdio: 'ignore',
      });
      attach();
      try {
        await writeFile(path.join(mnt, 'README.md'), '# Vol\n');
        await writeFile(path.join(mnt, 'other.txt'), 'other\n');
        await use(mnt);
      } finally {
        try {
          detach();
        } catch {
          /* 已卸载 */
        }
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });

  // 窗口获焦(app 'browser-window-focus';e2e 窗口不一定真拿到系统焦点,直接派发同一事件)。
  const focusWindow = (app: ElectronApplication) =>
    app.evaluate(({ app: electronApp, BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) electronApp.emit('browser-window-focus', {}, w);
    });

  test('卸载后获焦不再列旧文件;挂回后获焦列出卷内容,之后外部新建的文件照常出现', async ({ electronApp, window, workspaceRoot }) => {
    await waitForTestHooks(window);
    await expect(explorerTreeItem(window, /^other\.txt$/)).toBeVisible({ timeout: 15_000 });

    detach();
    expect(await readdir(workspaceRoot)).toEqual([]); // 挂载点目录还在,是空的
    await focusWindow(electronApp);
    await expect(explorerTreeItem(window, /^other\.txt$/)).toHaveCount(0, { timeout: 10_000 });

    attach();
    await focusWindow(electronApp);
    await expect(explorerTreeItem(window, /^other\.txt$/)).toBeVisible({ timeout: 10_000 });

    await writeFile(path.join(workspaceRoot, 'after-remount.txt'), 'x\n');
    await expect(explorerTreeItem(window, /^after-remount\.txt$/)).toBeVisible({ timeout: 10_000 });
  });
});
