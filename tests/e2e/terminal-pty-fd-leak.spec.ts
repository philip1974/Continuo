// 关闭终端后主进程不残留 PTY 句柄(BDD:src/__tests__/terminal-pty-fd-leak)。
// 真实应用里开关 10 个终端(一半点 tab 关闭按钮 = ⌘W 同一路径,一半 shell 内 exit 0 自动关面板),
// 用 lsof 数主进程的 PTY 主端(/dev/ptmx)与从端(/dev/ttys* / revoked),须回到开终端前的基线。
// node-pty 1.1.0 上每个终端漏 1 主端 + 1 从端(macOS posix_spawn 路径),仅 macOS 有此问题与 lsof 计数口径。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';

const ROUNDS = 10;

test.skip(process.platform !== 'darwin' || !existsSync('/usr/sbin/lsof'), '仅 macOS(lsof 计数口径)');

function ptyFds(pid: number): { master: number; slave: number } {
  const lines = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-p', String(pid)], { encoding: 'utf8' }).split('\n');
  return {
    master: lines.filter((l) => l.includes('/dev/ptmx')).length,
    slave: lines.filter((l) => /\/dev\/ttys\d+|\(revoked\)/.test(l)).length,
  };
}

async function openTerminal(window: Page) {
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  const byName = window.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(byName).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  // 等提示符出现(shell 就绪)
  await expect
    .poll(() => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? ''), { timeout: 15_000 })
    .not.toBe('');
  return byName;
}

test(`开关 ${ROUNDS} 个终端后主进程 PTY 句柄回到基线`, async ({ electronApp, window }) => {
  test.setTimeout(180_000);
  const pid = electronApp.process().pid!;
  await waitForTestHooks(window);
  const baseline = ptyFds(pid);

  for (let i = 0; i < ROUNDS; i++) {
    const tab = await openTerminal(window);
    // 开着时确实持有 PTY(防计数口径失效导致假绿)
    expect(ptyFds(pid).master).toBeGreaterThan(baseline.master);
    const tabs = window.getByRole('tab', { name: TERMINAL_PANEL_TAB });
    if (i % 2 === 0) {
      await tab.getByRole('button').last().click();
    } else {
      // zsh 初始化 zle 时可能丢弃预输入:面板还在就重发(面板已关则不再键入,免得打进别处)
      await expect(async () => {
        if ((await tabs.count()) > 0) {
          await window.getByRole('textbox', { name: TERMINAL_INPUT }).focus();
          await window.keyboard.type('exit 0');
          await window.keyboard.press('Enter');
        }
        await expect(tabs).toHaveCount(0, { timeout: 4_000 });
      }).toPass({ timeout: 20_000 });
    }
    await expect(tabs).toHaveCount(0, { timeout: 15_000 });
  }

  // 关闭按钮路径:Ctrl+C 后 3s 宽限再 SIGKILL,留足时间
  await expect.poll(() => ptyFds(pid), { timeout: 20_000, intervals: [500] }).toEqual(baseline);
});
