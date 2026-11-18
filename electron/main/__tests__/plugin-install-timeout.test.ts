// 插件安装 clone 60s 超时:放行 ssh 后(用户全局 insteadOf 把 https 改写成 ssh),首次连接需确认 host key
// 或私钥带口令时 GUI 无终端可应答,只会超时。超时须带独立错误码 GIT_TIMEOUT,renderer 按 code 本地化出
// 「确认 ssh 主机密钥已信任且无需交互口令」的提示(en/zh/ko)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

let spawned = 0;
class HangingChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: () => {
    spawned += 1;
    return new HangingChild(); // 永不退出:模拟 ssh 等待 host key 确认 / 口令
  },
}));

import { installFromGit } from '../services/plugins.service';
import { en } from '../../shared/i18n-locales/en';
import { zh } from '../../shared/i18n-locales/zh';
import { ko } from '../../shared/i18n-locales/ko';

let root: string | null = null;
afterEach(async () => {
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  root = null;
});

describe('插件 git 安装超时', () => {
  it('clone 挂起超时 → 错误码 GIT_TIMEOUT', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'plugin-install-timeout-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = installFromGit('https://example.com/p.git', path.join(root, 'plugins'));
    const settled = p.catch((e: unknown) => e);
    while (spawned === 0) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(60_000);
    const err = (await settled) as { code?: string };
    expect(err.code).toBe('GIT_TIMEOUT');
  });

  it('errors.GIT_TIMEOUT 三语文案都提示 ssh 主机密钥 / 交互口令', () => {
    const catalogs = [en, zh, ko] as unknown as Record<string, string>[];
    for (const c of catalogs) {
      expect(c['errors.GIT_TIMEOUT']).toMatch(/ssh/);
    }
    expect((zh as unknown as Record<string, string>)['errors.GIT_TIMEOUT']).toContain('主机密钥');
  });
});
