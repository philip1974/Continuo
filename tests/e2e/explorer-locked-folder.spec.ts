// 子目录读取失败(VSCode:展开失败的目录下显示错误行):无读权限的目录展开 → 该目录下一行内联错误
// (按错误码本地化的「拒绝访问」,不显示 EACCES 原始诊断串)+「重试」;恢复权限后重试 → 列出子项。
// root 用户 / Windows 无 chmod 000 语义,跳过。
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';

test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'needs POSIX permissions');

test('无读权限的目录展开 → 内联错误行 + 重试;「重试」上 Delete / ← 不动目录,Enter 重试后列出子项', async ({ window, workspaceRoot }) => {
  const locked = path.join(workspaceRoot, 'locked');
  await mkdir(locked);
  await writeFile(path.join(locked, 'inside.txt'), 'x');
  await chmod(locked, 0o000);
  try {
    const row = window.locator(`[role=treeitem][title="${locked}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    const tree = window.getByRole('tree');
    const message = tree.getByText(/^(无法读取此文件夹|Unable to read this folder|이 폴더를 읽을 수 없습니다)/);
    await expect(message).toBeVisible({ timeout: 5_000 });
    await expect(message).toContainText(/拒绝访问|Access denied|액세스 거부/);
    await expect(message).not.toContainText('EACCES');
    // 没有原始诊断串的 toast
    await expect(window.getByText(/listDir failed/)).toHaveCount(0);
    // 读屏:失败经常驻 live region 播报(带目录名),错误行自身不是 alert
    await expect(window.locator('[aria-live="assertive"]', { hasText: 'locked' })).toHaveCount(1);
    await expect(tree.getByRole('alert')).toHaveCount(0);

    // 焦点在「重试」上:Delete / ← 不动失败目录(不删、不收起)
    const retry = tree.getByRole('button', { name: /^(重试|Retry|다시 시도)$/ });
    await retry.focus();
    await window.keyboard.press('Delete');
    await window.keyboard.press('ArrowLeft');
    await expect(window.getByRole('alertdialog')).toHaveCount(0);
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(retry).toBeFocused();

    // Enter 激活「重试」(不是收起目录)
    await chmod(locked, 0o755);
    await window.keyboard.press('Enter');
    await expect(explorerTreeItem(window, /^inside\.txt$/)).toBeVisible({ timeout: 5_000 });
    await expect(message).toBeHidden();
    await expect(row).toBeFocused();
  } finally {
    await chmod(locked, 0o755).catch(() => {});
  }
});
