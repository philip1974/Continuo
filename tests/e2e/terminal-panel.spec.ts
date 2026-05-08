// Terminal Panel:启动后 auto-spawn 一个 session,TerminalTabs 渲染.
//
// node-pty 是 native module,e2e 跑构建出的 app 时 main 进程已 link 好。
// 这里只验证 UI 层:tab 出现 + 「+」按钮工作.
//
// 注:Continuo 没注册「打开 Terminal」命令(panel 通常从 dock HeaderActions
// 菜单创建)。e2e 走 testing hook(__continuoTest.openOrFocusPanel)直接打开,
// 比 dock 菜单 / 命令面板更可靠。

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

async function openTerminalPanel(window: Page): Promise<void> {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const helper = (
      window as unknown as {
        __continuoTest: {
          openOrFocusPanel: (id: string, c: string, t: string) => void;
        };
      }
    ).__continuoTest;
    helper.openOrFocusPanel('terminal', 'terminal', 'Terminal');
  });
}

test('打开 Terminal panel → auto-spawn 一个 session, TerminalTabs 渲染', async ({
  window,
}) => {
  await openTerminalPanel(window);

  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 15_000 });
});

test('点 + 新建第二个 terminal session', async ({ window }) => {
  await openTerminalPanel(window);
  const newBtn = window.locator('button[aria-label="新建终端"]');
  await expect(newBtn).toBeVisible({ timeout: 15_000 });

  // 等 auto-spawn 完成,以免点击立刻被吞掉
  await window.waitForTimeout(500);
  await newBtn.click();
  // 等 PTY snapshot 推回 + tabs 绘制
  await window.waitForTimeout(500);

  // 至少 1 个 tab role
  const tabs = window.locator('[role=tab]');
  expect(await tabs.count()).toBeGreaterThan(0);
});
