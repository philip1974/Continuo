// 资源管理器 git 状态装饰(VSCode git 扩展同款):临时 git 仓库里改文件 → M、新文件 → U、.gitignore 命中 → 置灰、
// 文件夹继承子项颜色(无字母);点文件默认可见、.git 不可见;关掉 explorer.decorations.* 后装饰消失;不触发窗口获焦地换根
//(打开最近 → 子目录 / 另一仓库 / 回原仓库;关闭文件夹后从「未打开文件夹」首次打开)后装饰照常出现。
// BDD: src/__tests__/explorer-git-decorations/
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_CLOSE_FOLDER,
  EXPLORER_NO_FOLDER_OPEN,
  explorerMoreActionsButton,
  explorerSidebar,
  explorerTreeItem,
} from './helpers/explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';

const row = (window: Page, name: string) =>
  window.locator('[role=treeitem]').filter({ has: window.locator('span.truncate', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
const nameOf = (window: Page, name: string) => row(window, name).locator('span.truncate');

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

test('git 状态:M / U / 置灰 / 文件夹继承;关掉设置后消失', async ({ window, workspaceRoot }) => {
  // 真实焦点语义(窗口获焦刷新不被模拟焦点干扰)
  try {
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch {
    // Electron 某些版本不支持该 CDP 域:不影响本用例(刷新也由 fs 变化触发)
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
  writeFileSync(path.join(workspaceRoot, '.gitignore'), '*.log\n');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  await expect(explorerTreeItem(window, /^README\.md$/)).toBeVisible({ timeout: 10_000 });
  // 点文件默认可见;.git 不可见
  await expect(row(window, '.gitignore')).toBeVisible({ timeout: 10_000 });
  await expect(row(window, '.git')).toHaveCount(0);

  await row(window, 'src').click();
  await expect(row(window, 'a.ts')).toBeVisible();

  writeFileSync(path.join(workspaceRoot, 'src/a.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(workspaceRoot, 'src/new.ts'), 'x\n');
  writeFileSync(path.join(workspaceRoot, 'debug.log'), 'log\n');

  await expect(nameOf(window, 'a.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: 10_000 });
  await expect(row(window, 'a.ts')).toContainText(/M$/);
  await expect(nameOf(window, 'new.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: 10_000 });
  await expect(row(window, 'new.ts')).toContainText(/U$/);
  await expect(nameOf(window, 'debug.log')).toHaveClass(/\btext-git-ignored\b/, { timeout: 10_000 });
  await expect(row(window, 'debug.log')).not.toContainText(/[MU]$/);
  // 文件夹继承(修改优先于未跟踪),无字母
  await expect(nameOf(window, 'src')).toHaveClass(/\btext-git-modified\b/);
  await expect(row(window, 'src')).not.toContainText(/M$/);
  await expect(nameOf(window, 'README.md')).not.toHaveClass(/text-git-/);
  // 颜色真的生效(text-git-* 已生成,暗色 = VSCode gitDecoration.modifiedResourceForeground #e2c08d)
  await expect
    .poll(() => nameOf(window, 'a.ts').evaluate((el) => getComputedStyle(el).color))
    .toBe('rgb(226, 192, 141)');

  // 关掉两项设置 → 装饰消失
  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('explorer.decorations.colors', false);
    t.setSettingValue('explorer.decorations.badges', false);
  });
  await expect(nameOf(window, 'a.ts')).not.toHaveClass(/text-git-/, { timeout: 5_000 });
  await expect(row(window, 'a.ts')).not.toContainText(/M$/);
  await expect(nameOf(window, 'src')).not.toHaveClass(/text-git-/);
  await expect(nameOf(window, 'debug.log')).not.toHaveClass(/text-git-/);
});

test('不触发窗口获焦地换根(打开最近 / 首次打开):新根的装饰随即出现', async () => {
  test.setTimeout(120_000);
  const tmp: string[] = [];
  const temp = (prefix: string) => {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    tmp.push(d);
    return d;
  };
  const ud = temp('ui106-gd-ud-');
  const repoA = temp('ui106-gd-a-');
  const repoB = temp('ui106-gd-b-');
  const sub = path.join(repoA, 'pkgsub');
  mkdirSync(sub);
  writeFileSync(path.join(repoA, 'top.ts'), '1\n');
  writeFileSync(path.join(sub, 'inner.ts'), '1\n');
  writeFileSync(path.join(repoB, 'tracked.ts'), '1\n');
  for (const r of [repoA, repoB]) {
    gitIn(r, 'init', '-q');
    gitIn(r, 'add', '.');
    gitIn(r, 'commit', '-q', '-m', 'init');
  }
  writeFileSync(path.join(repoA, 'top.ts'), '2\n');
  writeFileSync(path.join(sub, 'inner.ts'), '2\n');
  writeFileSync(path.join(repoB, 'fresh.ts'), 'x\n');
  seedExplorerJson(ud, { root: repoA, recentRoots: [repoA, sub, repoB] });

  const app = await launchContinuo(ud);
  try {
    const win = await app.firstWindow();
    await waitForAppReady(win);
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    await expect(nameOf(win, 'top.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: 15_000 });
    // 之后不再有窗口 focus 事件:换根后的装饰只能来自换根本身的查询
    await win.evaluate(() => {
      (globalThis as { __e2eWindowFocusCount?: number }).__e2eWindowFocusCount = 0;
      window.addEventListener('focus', () => ((globalThis as { __e2eWindowFocusCount?: number }).__e2eWindowFocusCount! += 1));
    });

    const openRecent = async (dir: string) => {
      await explorerMoreActionsButton(win).click();
      // 菜单项名称「名称，父路径」:按开头的名称精确匹配(子目录项的父路径里也含仓库名)
      await win.getByRole('menuitem', { name: new RegExp(`^${path.basename(dir)}[，,]`) }).click();
    };
    // 装饰须在 fs 变化 / 获焦刷新之外出现:5s 内(此前要等到获焦或文件变化)
    const DECO_TIMEOUT = 5_000;

    await openRecent(sub);
    await expect(row(win, 'inner.ts')).toBeVisible({ timeout: 10_000 });
    await expect(nameOf(win, 'inner.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: DECO_TIMEOUT });

    await openRecent(repoB);
    await expect(row(win, 'fresh.ts')).toBeVisible({ timeout: 10_000 });
    await expect(nameOf(win, 'fresh.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: DECO_TIMEOUT });
    await expect(nameOf(win, 'tracked.ts')).not.toHaveClass(/text-git-/);

    await openRecent(repoA);
    await expect(row(win, 'top.ts')).toBeVisible({ timeout: 10_000 });
    await expect(nameOf(win, 'top.ts')).toHaveClass(/\btext-git-modified\b/, { timeout: DECO_TIMEOUT });

    // 关闭文件夹 → 从「未打开文件夹」的最近列表首次打开
    await explorerMoreActionsButton(win).click();
    await win.getByRole('menu').getByRole('menuitem', { name: EXPLORER_CLOSE_FOLDER }).click();
    await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({ timeout: 5_000 });
    await explorerSidebar(win)
      .getByRole('button', { name: new RegExp(`^${path.basename(repoB)}[，,]`) })
      .click();
    await expect(row(win, 'fresh.ts')).toBeVisible({ timeout: 10_000 });
    await expect(nameOf(win, 'fresh.ts')).toHaveClass(/\btext-git-untracked\b/, { timeout: DECO_TIMEOUT });

    expect(await win.evaluate(() => (globalThis as { __e2eWindowFocusCount?: number }).__e2eWindowFocusCount)).toBe(0);
  } finally {
    await closeDiscardingUnsaved(app).catch(() => undefined);
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  }
});
