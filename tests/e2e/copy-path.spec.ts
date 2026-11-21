// 右键「复制路径 / 复制相对路径」→ 系统剪贴板.
//
// 注意:Continuo PROD 模式 sandboxSweep 会把 renderer 的 navigator.clipboard
// 涂成 undefined。e2e 跑的是 build 产物(PROD),所以 page.evaluate 内读不到。
// 用 Playwright 的 ElectronApplication.evaluate 在 main 进程通过
// Electron clipboard API 读 — 这是真正的系统剪贴板,跨进程一致.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const COPY_PATH = /^(复制路径|Copy Path|경로 복사)$/;
const COPY_RELATIVE_PATH = /^(复制相对路径|Copy Relative Path|상대 경로 복사)$/;

test('右键 README.md →「复制路径」→ 剪贴板 = 绝对路径', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const copyItem = window.getByRole('menuitem', { name: COPY_PATH });
  await expect(copyItem).toBeVisible();
  await copyItem.click();

  await expect
    .poll(
      () => electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      { timeout: 5_000 },
    )
    .toBe(path.join(workspaceRoot, 'README.md'));
});

test('右键 README.md →「复制相对路径」→ 剪贴板 = 文件名', async ({
  window,
  electronApp,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const copyItem = window.getByRole('menuitem', { name: COPY_RELATIVE_PATH });
  await expect(copyItem).toBeVisible();
  await copyItem.click();

  await expect
    .poll(
      () => electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      { timeout: 5_000 },
    )
    .toBe('README.md');
});
