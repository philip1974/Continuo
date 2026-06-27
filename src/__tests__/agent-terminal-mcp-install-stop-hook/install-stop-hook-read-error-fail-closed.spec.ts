// 数据安全(codex 复查 P1,「读失败当空→写覆盖」族):install_stop_hook 读现有
// .claude/settings.local.json / .codex/config.toml 时,此前把**所有** readFile 错误当
// 「文件不存在」→ 空配置 → atomicWriteFile 用只含 managed hook 的内容覆盖用户真实配置。
// 修复:readFile catch 只吞 ENOENT,EACCES/EIO 等 fail-fast 返回 read-error,绝不写入。

// 边界(E162):readConfigCapped 改用共享 readFileCappedFd(read-fh-capped.ts,经 node:fs 的 promises
// `fs.open`)。故 EACCES 用 spyOn(fsp,'open') 模拟(原 mock node:fs/promises 的 readFile)——与
// plugins-service / explorer 的 TOCTOU 测试一致,spy 落在 read-fh-capped 实际使用的 node:fs promises。
import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inferRunner,
  installStopHookForSession,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

const realReadFile = fsp.readFile;

const roots: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makeCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'continuo-hook-readerr-'));
  roots.push(root);
  return root;
}

function failReadFor(target: string): void {
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation((async (
    p: unknown,
    ...rest: unknown[]
  ) => {
    if (String(p) === target) {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }
    return (realOpen as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof fsp.open);
}

describe('install_stop_hook 配置读错误 fail-closed(不覆盖用户配置)', () => {
  it('Claude settings.local.json 读 EACCES → read-error,原配置不被覆盖', async () => {
    const cwd = await makeCwd();
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    const original = '{"existing":"user-config"}';
    await writeFile(settingsPath, original, 'utf8');

    failReadFor(settingsPath);
    const runner = inferRunner({ id: 't', cwd, agentLabel: 'claude' });
    await expect(
      installStopHookForSession(cwd, runner, join(cwd, '.continuo', 'hk')),
    ).resolves.toEqual({ installed: false, reason: 'read-error' });

    expect(await realReadFile(settingsPath, 'utf8')).toBe(original); // 未被覆盖
  });

  it('Codex config.toml 读 EACCES → read-error,原配置不被覆盖', async () => {
    const cwd = await makeCwd();
    const configPath = join(cwd, '.codex', 'config.toml');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    const original = 'model = "gpt-5.5"\n';
    await writeFile(configPath, original, 'utf8');

    failReadFor(configPath);
    const runner = inferRunner({ id: 't', cwd, agentLabel: 'codex' });
    await expect(
      installStopHookForSession(cwd, runner, join(cwd, '.continuo', 'hk')),
    ).resolves.toEqual({ installed: false, reason: 'read-error' });

    expect(await realReadFile(configPath, 'utf8')).toBe(original); // 未被覆盖
  });
});

// 边界(E66,E26 同款 stat-before-read):配置文件超 1MiB → config-too-large,
// 不进 JSON.parse/regex/atomicWrite,原文件不被覆盖。
describe('install_stop_hook 配置文件大小上限(E66)', () => {
  const OVER = 1024 * 1024 + 1; // > MAX_CONFIG_FILE_BYTES (1 MiB)

  it('Claude settings.local.json 超 1MiB → config-too-large,原文件不动', async () => {
    const cwd = await makeCwd();
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    // 超大但仍合法 JSON(证明拦在 parse 之前,不是 parse 失败):大 value 填充。
    const huge = `{"pad":"${'x'.repeat(OVER)}"}`;
    await writeFile(settingsPath, huge, 'utf8');

    const runner = inferRunner({ id: 't', cwd, agentLabel: 'claude' });
    await expect(
      installStopHookForSession(cwd, runner, join(cwd, '.continuo', 'hk')),
    ).resolves.toEqual({ installed: false, reason: 'config-too-large' });

    expect(await realReadFile(settingsPath, 'utf8')).toBe(huge); // 未被覆盖
  });

  it('Codex config.toml 超 1MiB → config-too-large,原文件不动', async () => {
    const cwd = await makeCwd();
    const configPath = join(cwd, '.codex', 'config.toml');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    const huge = `model = "gpt-5.5"\n# ${'y'.repeat(OVER)}\n`;
    await writeFile(configPath, huge, 'utf8');

    const runner = inferRunner({ id: 't', cwd, agentLabel: 'codex' });
    await expect(
      installStopHookForSession(cwd, runner, join(cwd, '.continuo', 'hk')),
    ).resolves.toEqual({ installed: false, reason: 'config-too-large' });

    expect(await realReadFile(configPath, 'utf8')).toBe(huge); // 未被覆盖
  });
});
