// 资源管理器树内按住 ⌥(mac)/ Ctrl 拖放 = 复制(VSCode isCopy;BDD: src/__tests__/explorer-drag-copy/):
// 不弹移动确认、源不动、复制出的文件在编辑器常驻打开;拖到原父目录生成「copy」副本。真实鼠标拖动(dragover 足够密)。
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { expandTreeItem } from './helpers/explorer';

const COPY_KEY = process.platform === 'darwin' ? 'Alt' : 'Control';
const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);
const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

/** 按住复制键,真实鼠标从 from 拖到 to(中途多次移动,保证 dragover 足够密)再松开。 */
async function copyDrag(window: Page, from: Locator, to: Locator): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await window.keyboard.down(COPY_KEY);
  try {
    await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await window.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      await window.mouse.move(
        a.x + a.width / 2 + ((b.x - a.x) * i) / steps,
        a.y + a.height / 2 + ((b.y + b.height / 2 - (a.y + a.height / 2)) * i) / steps,
      );
    }
    await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await window.mouse.up();
  } finally {
    await window.keyboard.up(COPY_KEY);
  }
}

test('按住 ⌥ 拖到文件夹 → 复制(不确认、源不动、复制出的文件常驻打开);拖到原父目录 → 生成 copy 副本', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const src = path.join(workspaceRoot, 'src');
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });

  await copyDrag(window, rowOf(window, readme), rowOf(window, src));
  await expect.poll(() => exists(path.join(src, 'README.md')), { timeout: 10_000 }).toBe(true);
  expect(await exists(readme)).toBe(true);
  await expect(window.getByRole('dialog')).toHaveCount(0);
  const tabs = window.locator('[data-editor-panel-root]').first().getByRole('tablist', { name: EDITOR_TABS });
  await expect(tabs.getByRole('tab', { name: /^README\.md/ })).toHaveAttribute('title', path.join(src, 'README.md'));

  // 拖到原父目录(拖到同目录的另一文件上 = 其所在目录)→ a copy.ts
  await expandTreeItem(window, 'src');
  const a = path.join(src, 'a.ts');
  await expect(rowOf(window, a)).toBeVisible();
  await copyDrag(window, rowOf(window, a), rowOf(window, path.join(src, 'b.ts')));
  await expect.poll(() => exists(path.join(src, 'a copy.ts')), { timeout: 10_000 }).toBe(true);
  expect(await exists(a)).toBe(true);
});
