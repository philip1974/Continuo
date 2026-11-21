// BDD: agent-terminal-mcp-install-stop-hook · I12 安装位置限定在调用方窗口 workspace 内(安全)
//
// 攻击:`create_session{cwd:"$HOME", agentLabel:"codex", install_stop_hook:true}` → 改写全局
// `~/.codex/config.toml`(持久化,workspace 外);cwd 不存在时 `mkdir -p` 建出任意目录树。
// 契约:安装前 cwd 与会话同一解析(须已存在且为目录),realpath 后须在窗口 workspace 根之内,且不得是
// 用户 home 或其祖先;否则拒绝安装(installed:false),不写任何文件、不建目录。会话本身仍照常创建。

import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
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
  stat?: (p: string) => Promise<{ dev: bigint; ino: bigint }>;
}) {
  return installStopHookInWorkspace({
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    homeDir: opts.homeDir,
    runner: opts.runner ?? 'codex',
    hookEventsDir: '/x/hook-events',
    resolveCwd,
    ...(opts.stat ? { stat: opts.stat } : {}),
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

// 「是否为 home 或其祖先」按 (dev, ino) 判定:同一目录可以有 realpath 不归一的别的路径(macOS 的
// `/.nofollow/<绝对路径>`、数据卷 `/System/Volumes/Data/<绝对路径>`;Linux bind mount;Windows subst)。
// 窗口 workspace 是 home 的祖先(`/`、`/Users`)时,agent 用别名写 cwd 即可把 hook 装进全局 ~/.claude、~/.codex。
describe('I12b home 判定不看路径字符串(文件系统别名)', () => {
  const realStat = (p: string) => stat(p, { bigint: true });

  it('cwd 与 home 是同一个 inode(路径字符串不同)→ 拒绝,不写配置', async () => {
    const root = await realpath(await makeRoot());
    const home = join(root, 'home');
    const alias = join(root, 'alias-of-home');
    await mkdir(home);
    await mkdir(alias);
    for (const runner of ['codex', 'cc'] as const) {
      const r = await install({
        cwd: alias,
        workspaceRoot: root,
        homeDir: home,
        runner,
        stat: (p) => realStat(p === alias ? home : p),
      });
      expect(r).toEqual({ installed: false, reason: 'cwd-is-home-or-ancestor' });
    }
    expect(await readdir(alias)).toEqual([]);
  });

  it('cwd 与 home 的某级祖先是同一个 inode → 拒绝', async () => {
    const root = await realpath(await makeRoot());
    const parent = join(root, 'users');
    const home = join(parent, 'me');
    const alias = join(root, 'alias-of-users');
    await mkdir(home, { recursive: true });
    await mkdir(alias);
    const r = await install({
      cwd: alias,
      workspaceRoot: root,
      homeDir: home,
      stat: (p) => realStat(p === alias ? parent : p),
    });
    expect(r).toEqual({ installed: false, reason: 'cwd-is-home-or-ancestor' });
    expect(await readdir(alias)).toEqual([]);
  });

  it('cwd 的身份取不到(stat 失败)→ fail-closed 拒绝', async () => {
    const ws = await makeRoot();
    const sub = join(ws, 'pkg');
    await mkdir(sub);
    const r = await install({
      cwd: sub,
      workspaceRoot: ws,
      homeDir: '/nonexistent-home',
      stat: async (p) => {
        if (p.endsWith('pkg')) throw new Error('EACCES');
        return realStat(p);
      },
    });
    expect(r.installed).toBe(false);
    expect(await readdir(sub)).toEqual([]);
  });

  // 真实别名只在 macOS 上有(其余平台由上面的 stat 桩证明「inode 相同即拒」)。
  const dataVolume = '/System/Volumes/Data';
  it.runIf(process.platform === 'darwin' && existsSync(dataVolume))(
    'macOS:workspace 为 `/`,cwd 用数据卷别名指向 home / home 的祖先 → 拒绝',
    async () => {
      const root = await realpath(await makeRoot());
      const home = join(root, 'home');
      await mkdir(home);
      for (const target of [home, root]) {
        const r = await install({ cwd: dataVolume + target, workspaceRoot: '/', homeDir: home });
        expect(r).toEqual({ installed: false, reason: 'cwd-is-home-or-ancestor' });
      }
      expect(await readdir(home)).toEqual([]);
      expect(await readdir(root)).toEqual(['home']);
    },
  );

  it.runIf(process.platform === 'darwin' && existsSync('/.nofollow'))(
    'macOS:cwd 第一段是内核合成前缀(/.nofollow 等)→ 一律拒绝,即便指向的是 workspace 内的普通目录',
    async () => {
      const root = await realpath(await makeRoot());
      const home = join(root, 'home');
      const proj = join(root, 'proj');
      await mkdir(home);
      await mkdir(proj);
      for (const target of [home, proj]) {
        const r = await install({ cwd: '/.nofollow' + target, workspaceRoot: '/', homeDir: home });
        expect(r).toEqual({ installed: false, reason: 'cwd-outside-workspace' });
      }
      expect(await readdir(home)).toEqual([]);
      expect(await readdir(proj)).toEqual([]);
    },
  );
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
