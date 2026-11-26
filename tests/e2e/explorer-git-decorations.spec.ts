// 资源管理器 git 状态装饰(VSCode git 扩展同款):临时 git 仓库里改文件 → M、新文件 → U、.gitignore 命中 → 置灰、
// 文件夹继承子项颜色(无字母);点文件默认可见、.git 不可见;关掉 explorer.decorations.* 后装饰消失。
// BDD: src/__tests__/explorer-git-decorations/
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';
import { waitForTestHooks } from './helpers/app-ready';

const row = (window: Page, name: string) =>
  window.locator('[role=treeitem]').filter({ has: window.locator('span.truncate', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
const nameOf = (window: Page, name: string) => row(window, name).locator('span.truncate');

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
