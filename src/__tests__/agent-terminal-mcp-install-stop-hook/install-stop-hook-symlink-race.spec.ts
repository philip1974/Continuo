// BDD: agent-terminal-mcp-install-stop-hook · I11 检查 → 读 / 写之间被并发换成符号链接 → fail-closed
//
// 安全(H1 续):I9 的 guardConfigPath 只在入口检查一次。并发进程(如只能写工作区的沙箱 agent)可在检查之后:
//   ① 把配置文件换成指向仓库外的链接 → 读取跟随链接,仓库外内容经备份写进工作树;
//   ② 把 `.codex` / `.claude` 目录换成(或新建为)指向 `~/.codex` 的链接 → mkdir -p 放行已存在链接,
//      备份与 rename 的中间路径跟随链接 → 替换全局配置(可含 notify/MCP 命令 → 沙箱外执行)。
// 契约:读取不跟随文件链接(O_NOFOLLOW / 退化 lstat+fstat 同 inode)且只读普通文件;mkdir 之后、写备份
// 与 rename 之前再查一次目录链与读到的文件身份,任何一环变成链接 / 被替换 → unsafe-config-path,
// 仓库外目标不变,不产生备份。
//
// 用 vi.mock 包住 readFileCappedFd,在「检查之后读之前」或「读之后写之前」执行替换,确定性复现竞态窗口。

import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Swap = { readonly when: 'before-read' | 'after-read'; readonly run: () => Promise<void> };
const swapState = vi.hoisted(() => ({ swap: null as Swap | null, configPath: '' }));

vi.mock('../../../electron/main/lib/read-fh-capped', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../electron/main/lib/read-fh-capped')>();
  return {
    ...orig,
    readFileCappedFd: async (...args: Parameters<typeof orig.readFileCappedFd>) => {
      const s = args[0] === swapState.configPath ? swapState.swap : null;
      if (s?.when === 'before-read') await s.run();
      try {
        return await orig.readFileCappedFd(...args);
      } finally {
        if (s?.when === 'after-read') await s.run();
      }
    },
  };
});

const { inferRunner, installStopHookForSession } = await import(
  '../../../electron/main/services/mcp-tools-hook-bridge'
);

const roots: string[] = [];
afterEach(async () => {
  swapState.swap = null;
  swapState.configPath = '';
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makeDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

async function listBackups(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  return names.map(String).filter((n) => n.includes('.continuo-bak.'));
}

const cc = inferRunner({ id: 't', cwd: '/r', agentLabel: 'claude' });
const codex = inferRunner({ id: 't', cwd: '/r', agentLabel: 'codex' });
const SECRET = 'Host prod\n  IdentityFile ~/.ssh/id_secret\n';
const GLOBAL_CODEX = 'notify = ["/usr/bin/true"]\n';
const MANAGED_OLD_CODEX =
  '\n# continuo-managed\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\n' +
  'command = "mkdir -p \\"/old\\" && cat > \\"${CONTINUO_HOOK_EVENTS_DIR:-/old}/x.jsonl\\""\n';

describe.skipIf(process.platform === 'win32')('I11 检查之后配置文件被换成链接', () => {
  it('cc: 读取前 settings.local.json 换成仓库外链接 → 拒绝,机密不进工作树', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const outside = await makeDir('continuo-hook-race-out-');
    const secret = join(outside, 'secret');
    await writeFile(secret, SECRET, 'utf8');
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'));
    await writeFile(settingsPath, '{"k":1}', 'utf8');
    swapState.configPath = settingsPath;
    swapState.swap = {
      when: 'before-read',
      run: async () => {
        await rm(settingsPath);
        await symlink(secret, settingsPath);
      },
    };

    await expect(installStopHookForSession(cwd, cc, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await listBackups(cwd)).toEqual([]);
    expect(await readFile(secret, 'utf8')).toBe(SECRET);
  });
});

describe.skipIf(process.platform === 'win32')('I11 检查之后配置目录被换成链接', () => {
  async function setupOutsideCodex(content: string): Promise<string> {
    const home = await makeDir('continuo-hook-race-home-');
    await writeFile(join(home, 'config.toml'), content, 'utf8');
    return home;
  }

  it('codex: 读取后 .codex 换成指向 ~/.codex 的链接 → 拒绝,全局配置不变,无备份', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const home = await setupOutsideCodex(GLOBAL_CODEX);
    const configPath = join(cwd, '.codex', 'config.toml');
    await mkdir(join(cwd, '.codex'));
    await writeFile(configPath, 'model = "x"\n', 'utf8');
    swapState.configPath = configPath;
    swapState.swap = {
      when: 'after-read',
      run: async () => {
        await rename(join(cwd, '.codex'), join(cwd, '.codex-moved'));
        await symlink(home, join(cwd, '.codex'), 'junction');
      },
    };

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(GLOBAL_CODEX);
    expect(await readdir(home)).toEqual(['config.toml']);
  });

  it('codex 替换旧 managed 块路径:读取后 .codex 换成链接 → 同样拒绝', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const home = await setupOutsideCodex(GLOBAL_CODEX);
    const configPath = join(cwd, '.codex', 'config.toml');
    await mkdir(join(cwd, '.codex'));
    await writeFile(configPath, `model = "x"\n${MANAGED_OLD_CODEX}`, 'utf8');
    swapState.configPath = configPath;
    swapState.swap = {
      when: 'after-read',
      run: async () => {
        await rename(join(cwd, '.codex'), join(cwd, '.codex-moved'));
        await symlink(home, join(cwd, '.codex'), 'junction');
      },
    };

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(GLOBAL_CODEX);
    expect(await readdir(home)).toEqual(['config.toml']);
  });

  it('codex: 检查时 .codex 不存在,mkdir 前被建成链接 → 拒绝,不在 ~/.codex 写配置', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const home = await setupOutsideCodex(GLOBAL_CODEX);
    const configPath = join(cwd, '.codex', 'config.toml');
    swapState.configPath = configPath;
    swapState.swap = {
      when: 'after-read',
      run: async () => {
        await symlink(home, join(cwd, '.codex'), 'junction');
      },
    };

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(GLOBAL_CODEX);
    expect(await readdir(home)).toEqual(['config.toml']);
  });

  it('codex: .codex 不存在,mkdir 前被建成指向空的仓库外目录 → 拒绝,不在外部新建配置', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const outside = await makeDir('continuo-hook-race-home-');
    swapState.configPath = join(cwd, '.codex', 'config.toml');
    swapState.swap = {
      when: 'after-read',
      run: async () => {
        await symlink(outside, join(cwd, '.codex'), 'junction');
      },
    };

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('cc: 读取后 settings.local.json 被换成别的普通文件(身份变了)→ 拒绝,不覆盖', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'));
    await writeFile(settingsPath, '{"k":1}', 'utf8');
    swapState.configPath = settingsPath;
    swapState.swap = {
      when: 'after-read',
      run: async () => {
        await writeFile(`${settingsPath}.new`, '{"other":2}', 'utf8');
        await rename(`${settingsPath}.new`, settingsPath);
      },
    };

    await expect(installStopHookForSession(cwd, cc, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(settingsPath, 'utf8')).toBe('{"other":2}');
    expect(await listBackups(cwd)).toEqual([]);
  });
});

describe('I11 对照:无并发替换时照常安装', () => {
  it('codex 新建与 cc 合并已有配置均成功', async () => {
    const cwd = await makeDir('continuo-hook-race-cwd-');
    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: true,
    });
    await mkdir(join(cwd, '.claude'));
    await writeFile(join(cwd, '.claude', 'settings.local.json'), '{"k":1}', 'utf8');
    await expect(installStopHookForSession(cwd, cc, join(cwd, 'hk'))).resolves.toEqual({
      installed: true,
    });
  });
});
