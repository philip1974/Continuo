// BDD: agent-terminal-mcp-install-stop-hook · I9 项目内符号链接 fail-closed
//
// 安全(H1):install_stop_hook 写的是 agent 所在仓库(可能不可信)里的 .claude/settings.local.json /
// .codex/config.toml。仓库可预置符号链接,如 `.codex/config.toml -> ~/.ssh/config`、
// `.claude/settings.local.json -> ~/.claude/settings.json`,或 `.claude` / `.codex` 目录本身是链接。
// 此前:copyFile 把链接目标内容拷成仓库内 `.continuo-bak.<ts>`(机密进工作树),atomicWriteFile 写穿链接
// 追加内容 → 损坏目标 / 把 hook 装进全局配置。契约:任何一环是链接 → 拒绝安装(unsafe-config-path),
// 目标文件不被修改,不产生备份副本。

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inferRunner,
  installStopHookForSession,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
const CC_GLOBAL = '{"permissions":{"allow":["Bash(*)"]}}';
const MANAGED_OLD_CODEX =
  '\n# continuo-managed\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\n' +
  'command = "mkdir -p \\"/old\\" && cat > \\"${CONTINUO_HOOK_EVENTS_DIR:-/old}/x.jsonl\\""\n';

// 文件级 symlink 在 Windows 需特权;目录用 junction(无需特权)在全平台跑。
describe.skipIf(process.platform === 'win32')('I9 配置文件本身是符号链接 → 拒绝', () => {
  it('cc: .claude/settings.local.json -> 仓库外文件:拒绝,目标不变,无备份', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    const target = join(outside, 'settings.json');
    await writeFile(target, CC_GLOBAL, 'utf8');
    await mkdir(join(cwd, '.claude'));
    await symlink(target, join(cwd, '.claude', 'settings.local.json'));

    await expect(installStopHookForSession(cwd, cc, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(target, 'utf8')).toBe(CC_GLOBAL);
    expect((await lstat(join(cwd, '.claude', 'settings.local.json'))).isSymbolicLink()).toBe(true);
    expect(await listBackups(cwd)).toEqual([]);
    expect(await listBackups(outside)).toEqual([]);
  });

  it('codex: .codex/config.toml -> 仓库外机密:拒绝,目标不变,机密不进工作树', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    const target = join(outside, 'config');
    await writeFile(target, SECRET, 'utf8');
    await mkdir(join(cwd, '.codex'));
    await symlink(target, join(cwd, '.codex', 'config.toml'));

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(target, 'utf8')).toBe(SECRET);
    expect(await listBackups(cwd)).toEqual([]);
    expect(await listBackups(outside)).toEqual([]);
  });

  it('codex 替换旧 managed 块路径:config.toml 链接 → 同样拒绝,不写穿', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    const target = join(outside, 'config.toml');
    const original = `model = "x"\n${MANAGED_OLD_CODEX}`;
    await writeFile(target, original, 'utf8');
    await mkdir(join(cwd, '.codex'));
    await symlink(target, join(cwd, '.codex', 'config.toml'));

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(target, 'utf8')).toBe(original);
    expect(await listBackups(cwd)).toEqual([]);
    expect(await listBackups(outside)).toEqual([]);
  });

  it('备份目标名被预置为链接 → 拒绝,不经链接写出备份,原配置不变', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    const victim = join(outside, 'authorized_keys');
    await writeFile(victim, 'ssh-ed25519 AAAA victim\n', 'utf8');
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'));
    await writeFile(settingsPath, '{"k":1}', 'utf8');
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    await symlink(victim, `${settingsPath}.continuo-bak.1234567890`);

    const res = await installStopHookForSession(cwd, cc, join(cwd, 'hk'));
    expect(res).toEqual({ installed: false, reason: 'unsafe-config-path' });
    expect(await readFile(victim, 'utf8')).toBe('ssh-ed25519 AAAA victim\n');
    expect(await readFile(settingsPath, 'utf8')).toBe('{"k":1}');
  });
});

describe('I9 .claude / .codex 目录本身是链接(junction)→ 拒绝', () => {
  it('cc: .claude -> 仓库外目录:拒绝,目录内配置不变,无备份', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    await writeFile(join(outside, 'settings.local.json'), CC_GLOBAL, 'utf8');
    await symlink(outside, join(cwd, '.claude'), 'junction');

    await expect(installStopHookForSession(cwd, cc, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readFile(join(outside, 'settings.local.json'), 'utf8')).toBe(CC_GLOBAL);
    expect(await readdir(outside)).toEqual(['settings.local.json']);
  });

  it('codex: .codex -> 仓库外目录(配置尚不存在):拒绝,不在外部新建配置', async () => {
    const cwd = await makeDir('continuo-hook-link-cwd-');
    const outside = await makeDir('continuo-hook-link-out-');
    await symlink(outside, join(cwd, '.codex'), 'junction');

    await expect(installStopHookForSession(cwd, codex, join(cwd, 'hk'))).resolves.toEqual({
      installed: false,
      reason: 'unsafe-config-path',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('对照:cwd 本身经链接访问(如 macOS /tmp)仍正常安装', async () => {
    const real = await makeDir('continuo-hook-link-real-');
    const linkParent = await makeDir('continuo-hook-link-par-');
    const viaLink = join(linkParent, 'proj');
    await symlink(real, viaLink, 'junction');

    await expect(installStopHookForSession(viaLink, cc, join(real, 'hk'))).resolves.toEqual({
      installed: true,
    });
    expect((await lstat(join(real, '.claude', 'settings.local.json'))).isFile()).toBe(true);
  });
});
