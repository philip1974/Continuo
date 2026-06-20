// topic 49 第十二 session · codex 复审 loop R10:终端新建入口必须等 workspace hydrate 完成。
//
// 根因:workspace.store 有 `hydrated` 契约(stores/README + 注释明确「消费方读 root 前必须等
// hydrated」,且点名 TerminalPanel 解析 PTY cwd 的场景)。但 terminal.new(TerminalPlugin)与
// dock header 新建终端入口直接读 useWorkspaceStore.getState().root,没等 hydrated。
// initExplorerPersistence fire-and-forget,冷启动慢时 root 仍是初始 null → terminal.create
// 不带 cwd → main resolveTerminalCwd 抛 TERMINAL_CWD_UNRESOLVED → 首次新建失败且不重试。
// (「契约建了消费方漏用」族;违反文档契约 = 真 bug。)
//
// 修:两入口在读 root 前 await waitForWorkspaceHydrated()(已 hydrated 立即返回;markHydrated
// 在 init 成功/失败/无文件都会调,故不会挂死)。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import TerminalPlugin from '@/core-plugins/TerminalPlugin';
import {
  useWorkspaceStore,
  waitForWorkspaceHydrated,
} from '@/stores/workspace.store';

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn().mockResolvedValue({ ok: true, data: { id: 'term-new' } }),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: { create: mocks.createTerminal },
  },
}));

function terminalNewCmd(): CommandSpec {
  const commands: CommandSpec[] = [];
  const app = {
    panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    commands: {
      register: vi.fn((spec: CommandSpec) => {
        commands.push(spec);
        return { dispose: vi.fn() };
      }),
    },
  };
  const plugin = new TerminalPlugin(app as never, {
    id: 'core.terminal',
    name: 'Terminal',
    version: '1.0.0',
  });
  plugin.onload();
  return commands.find((c) => c.id === 'terminal.new')!;
}

beforeEach(() => {
  mocks.createTerminal.mockClear();
  useWorkspaceStore.setState({ hydrated: false, root: null, recentRoots: [] });
});

describe('topic49 codex-loop R10 · terminal.new 等 hydrate', () => {
  it('hydrated=false 时不立即创建终端;hydrate(带 root)后用真实 cwd 创建', async () => {
    const cmd = terminalNewCmd();

    let done = false;
    const p = Promise.resolve(cmd.fn!()).then(() => {
      done = true;
    });
    // 还没 hydrate → 不应读到 null root 就去创建
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(done).toBe(false);

    // 持久化层 hydrate 完成,root 已就绪
    useWorkspaceStore.getState().setRoot('/repo');
    useWorkspaceStore.getState().markHydrated();

    await p;
    expect(done).toBe(true);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', workspaceRoot: '/repo' }),
    );
  });

  it('已 hydrated 时 waitForWorkspaceHydrated 立即 resolve(不阻塞快路径)', async () => {
    useWorkspaceStore.setState({ hydrated: true });
    let resolved = false;
    await waitForWorkspaceHydrated().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });
});
