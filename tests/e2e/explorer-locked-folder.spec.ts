// 子目录读取失败(VSCode:展开失败的目录下显示错误行):无读权限的目录展开 → 该目录下一行内联错误
// (按错误码本地化的「拒绝访问」,不显示 EACCES 原始诊断串)+「重试」;恢复权限后重试 → 列出子项。
// root 用户 / Windows 无 chmod 000 语义,跳过。
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { explorerTreeItem } from './helpers/explorer';

test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'needs POSIX permissions');

test('无读权限的目录展开 → 内联错误行 + 重试;恢复权限后重试列出子项', async ({ window, workspaceRoot }) => {
  const locked = path.join(workspaceRoot, 'locked');
  await mkdir(locked);
  await writeFile(path.join(locked, 'inside.txt'), 'x');
  await chmod(locked, 0o000);
  try {
    const row = window.locator(`[role=treeitem][title="${locked}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    const tree = window.getByRole('tree');
    const alert = tree.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/拒绝访问|Access denied|액세스 거부/);
    await expect(alert).not.toContainText('EACCES');
    // 没有原始诊断串的 toast
    await expect(window.getByText(/listDir failed/)).toHaveCount(0);

    await chmod(locked, 0o755);
    await tree.getByRole('button', { name: /^(重试|Retry|다시 시도)$/ }).click();
    await expect(explorerTreeItem(window, /^inside\.txt$/)).toBeVisible({ timeout: 5_000 });
    await expect(alert).toBeHidden();
    await expect(row).toBeFocused();
  } finally {
    await chmod(locked, 0o755).catch(() => {});
  }
});
