// topic 49 第十二 session · codex 复审 loop R6:install_stop_hook 写 CLI 配置必须 crash-safe 原子写。
//
// 根因:mergeClaudeCodeSettings / mergeCodexConfig / replaceManagedCodexStopHook 写用户真实
// .claude/settings.local.json 和 .codex/config.toml 时直接 writeFile(truncate-then-write)。
// 写入中途崩溃/磁盘满/断电会把用户配置留成空/半截(.continuo-bak 备份需手工恢复,新建场景无备份)。
// 与 R4 plugin-fs writeFile / plugin-data atomicWriteJson 同源,平行写点漏了原子写保护。
//
// 修:三处改用 atomicWriteFile(同目录 tmp + fsync + rename 原子替换)。
//
// 验证手段:原子写经 rename 替换目标 → 目标 inode 变化(crash-safe 签名);裸 writeFile 就地
// truncate+write → inode 不变。断言写后 inode 改变 = 走了原子 rename 路径,且配置内容完整。

import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inferRunner,
  installStopHookForSession,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

let cwd: string;
const hookEventsDir = '/tmp/continuo-hook-events-test';

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pfs-stophook-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const ccRunner = inferRunner({ id: 't', cwd: '/r', agentLabel: 'claude' });

describe('topic49 codex-loop R6 · install_stop_hook 原子写配置', () => {
  it('合并 Claude settings 用原子写:目标 inode 变化 + 原有配置键保留', async () => {
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: 'dark', userKey: 'keep-me' }, null, 2),
      'utf8',
    );
    const inoBefore = (await stat(settingsPath)).ino;

    const res = await installStopHookForSession(cwd, ccRunner, hookEventsDir);
    expect(res.installed).toBe(true);

    // 原子 rename 替换 → 新 inode(裸 writeFile 就地写则 inode 不变)
    const inoAfter = (await stat(settingsPath)).ino;
    expect(inoAfter).not.toBe(inoBefore);

    // 配置内容完整:原 key 保留 + Stop hook 注入,仍是合法 JSON
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(parsed.userKey).toBe('keep-me');
    expect(parsed.theme).toBe('dark');
    expect(parsed.hooks.Stop).toBeDefined();
  });

  it('合并 Codex config 用原子写:目标 inode 变化 + 原有内容保留', async () => {
    const codexRunner = inferRunner({ id: 't', cwd: '/r', agentLabel: 'codex' });
    const configPath = join(cwd, '.codex', 'config.toml');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(configPath, 'personality = "pragmatic"\n', 'utf8');
    const inoBefore = (await stat(configPath)).ino;

    const res = await installStopHookForSession(cwd, codexRunner, hookEventsDir);
    expect(res.installed).toBe(true);

    const inoAfter = (await stat(configPath)).ino;
    expect(inoAfter).not.toBe(inoBefore);

    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('personality = "pragmatic"'); // 原内容保留
    expect(text).toContain('# continuo-managed'); // hook 追加
  });
});
