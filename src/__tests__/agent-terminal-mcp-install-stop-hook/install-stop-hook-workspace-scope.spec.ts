// BDD: agent-terminal-mcp-install-stop-hook · I12 安装位置限定在调用方窗口 workspace 内(安全)
//
// 攻击:`create_session{cwd:"$HOME", agentLabel:"codex", install_stop_hook:true}` → 改写全局
// `~/.codex/config.toml`(持久化,workspace 外);cwd 不存在时 `mkdir -p` 建出任意目录树。
// 契约:安装前 cwd 与会话同一解析(须已存在且为目录),realpath 后须在窗口 workspace 根之内,且不得是
// 用户 home 或其祖先;否则拒绝安装(installed:false),不写任何文件、不建目录。会话本身仍照常创建。

import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installStopHookForSession,
  installStopHookInWorkspace,
} from '../../../electron/main/services/mcp-tools-hook-bridge';
import { makeCreateSessionTool } from '../../../electron/main/services/mcp-tools-terminal';
import type { McpCallCtx } from '../../../electron/main/services/mcp-host.service';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'continuo-hook-ws-'));
  roots.push(r);
  return r;
}

// 与 resolveTerminalCwd 同语义的替身(缺省 / 不存在 / 非目录 → 抛)。
async function resolveCwd(hint?: string): Promise<string> {
  if (!hint || !(await stat(hint)).isDirectory()) throw new Error('cwd unresolved');
  return hint;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function install(opts: {
  cwd: string | undefined;
  workspaceRoot: string | null;
  homeDir: string;
  runner?: 'cc' | 'codex';
}) {
  return installStopHookInWorkspace({
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    homeDir: opts.homeDir,
    runner: opts.runner ?? 'codex',
    hookEventsDir: '/x/hook-events',
    resolveCwd,
  });
}

describe('I12 install_stop_hook 限定在 workspace 内', () => {
  it('cwd 在 workspace 之外 → 拒绝,不写配置', async () => {
    const root = await makeRoot();
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    await mkdir(ws);
    await mkdir(outside);
    const r = await install({ cwd: outside, workspaceRoot: ws, homeDir: join(root, 'home') });
    expect(r).toEqual({ installed: false, reason: 'cwd-outside-workspace' });
    expect(await exists(join(outside, '.codex'))).toBe(false);
  });

  it('cwd 是 workspace 的同名前缀兄弟目录(ws2 vs ws)→ 拒绝', async () => {
    const root = await makeRoot();
    const ws = join(root, 'ws');
    const sibling = join(root, 'ws2');
    await mkdir(ws);
    await mkdir(sibling);
    const r = await install({ cwd: sibling, workspaceRoot: ws, homeDir: join(root, 'home') });
    expect(r).toEqual({ installed: false, reason: 'cwd-outside-workspace' });
    expect(await exists(join(sibling, '.codex'))).toBe(false);
  });

  it('cwd 为用户 home(即便 workspace 就是 home)→ 拒绝,不写全局 ~/.codex/config.toml', async () => {
    const home = await makeRoot();
    for (const runner of ['codex', 'cc'] as const) {
      const r = await install({ cwd: home, workspaceRoot: home, homeDir: home, runner });
      expect(r).toEqual({ installed: false, reason: 'cwd-is-home-or-ancestor' });
    }
    expect(await readdir(home)).toEqual([]);
  });

  it('cwd 为 home 的祖先 → 拒绝', async () => {
    const root = await makeRoot();
    const home = join(root, 'home');
    await mkdir(home);
    const r = await install({ cwd: root, workspaceRoot: root, homeDir: home });
    expect(r).toEqual({ installed: false, reason: 'cwd-is-home-or-ancestor' });
    expect(await exists(join(root, '.codex'))).toBe(false);
  });

  it('cwd 不存在 → 拒绝,不 mkdir -p 出目录树', async () => {
    const ws = await makeRoot();
    const missing = join(ws, 'a', 'b');
    const r = await install({ cwd: missing, workspaceRoot: ws, homeDir: '/nonexistent-home' });
    expect(r.installed).toBe(false);
    expect(await exists(join(ws, 'a'))).toBe(false);
  });

  it('窗口无 workspace 根 → 拒绝', async () => {
    const dir = await makeRoot();
    const r = await install({ cwd: dir, workspaceRoot: null, homeDir: '/nonexistent-home' });
    expect(r).toEqual({ installed: false, reason: 'cwd-outside-workspace' });
    expect(await exists(join(dir, '.codex'))).toBe(false);
  });

  it('workspace 内的符号链接指向 workspace 外 → 按 realpath 拒绝', async () => {
    const root = await makeRoot();
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    await mkdir(ws);
    await mkdir(outside);
    await symlink(outside, join(ws, 'link'));
    const r = await install({ cwd: join(ws, 'link'), workspaceRoot: ws, homeDir: '/nonexistent-home' });
    expect(r).toEqual({ installed: false, reason: 'cwd-outside-workspace' });
    expect(await exists(join(outside, '.codex'))).toBe(false);
  });

  it('cwd 在 workspace 内 → 正常安装', async () => {
    const ws = await makeRoot();
    const sub = join(ws, 'pkg');
    await mkdir(sub);
    const r = await install({ cwd: sub, workspaceRoot: ws, homeDir: '/nonexistent-home' });
    expect(r).toEqual({ installed: true });
    expect(await exists(join(sub, '.codex', 'config.toml'))).toBe(true);
  });

  it('cwd 缺省 → 与会话同一解析回退到 workspace 根并安装', async () => {
    const ws = await makeRoot();
    const r = await install({ cwd: undefined, workspaceRoot: ws, homeDir: '/nonexistent-home', runner: 'cc' });
    expect(r).toEqual({ installed: true });
    expect(await exists(join(ws, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('底层安装函数自身:cwd 不存在时不递归建父链', async () => {
    const root = await makeRoot();
    const missing = join(root, 'a', 'b');
    for (const runner of ['codex', 'cc'] as const) {
      await installStopHookForSession(missing, runner, '/x').catch(() => undefined);
    }
    expect(await exists(join(root, 'a'))).toBe(false);
  });
});

describe('I12 create_session 把调用方窗口传给 installStopHook;被拒时会话照建', () => {
  it('stop_hook_installed:false 且会话创建', async () => {
    const installStopHook = vi.fn(async () => ({ installed: false }));
    const createSession = vi.fn(async () => ({ id: 'term-1' }));
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      installStopHook,
      createSession,
    });
    const ctx: McpCallCtx = { ownerWindowId: 7, callerSubject: 's' };
    const out = await tool.run(
      { install_stop_hook: true, agentLabel: 'codex', cwd: '/home/u' } as never,
      ctx,
    );
    expect(installStopHook).toHaveBeenCalledWith('/home/u', 'codex', 7);
    expect(out).toEqual({ session_id: 'term-1', stop_hook_installed: false });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
