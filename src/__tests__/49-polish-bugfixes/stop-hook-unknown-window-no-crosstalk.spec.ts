// topic 49 第十三轮 · P2-AK:来源窗口未知(windowId=null)的 Stop 事件不串到具体窗口。
//
// 根因:hook 文件名 `cc_${CONTINUO_WINDOW_ID:-unknown}_..` 在 CONTINUO_WINDOW_ID 未注入时
// 落成 `cc_unknown_..`,parseFilenameForWindowId 返回 null。旧 matchesFilter 对 entry.windowId
// ===null 跳过窗口校验当通配 → 非 Continuo 托管的外部 claude/codex(同 runner+cwd)的 Stop
// 事件会被某 Continuo 窗口的 await_stop_hook 等待者消费,泄漏他方 session_id/transcript_path/
// last_assistant_message。filter.windowId 类型恒为具体数,故改为严格相等(fail-closed),
// null entry 一律不匹配,但真实 windowId 的事件不受影响。

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createHookFileBroker,
  type HookFileBroker,
  type HookWatchFactory,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

const brokers: HookFileBroker[] = [];
const pollingWatchFactory: HookWatchFactory = (dir, onFile) => {
  const seen = new Set<string>();
  let closed = false;

  async function scan(): Promise<void> {
    if (closed) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    if (closed) return;
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      onFile(name);
    }
  }

  const timer = setInterval(() => void scan(), 20);
  void scan();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
};

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), `hook-crosstalk-${randomUUID()}-`));
}

async function makeBroker(dir: string): Promise<HookFileBroker> {
  const broker = createHookFileBroker(dir, {
    maxEntries: 64,
    maxAgeMs: 600_000,
    cleanupIntervalMs: 60_000,
    watchFactory: pollingWatchFactory,
  });
  await broker.start();
  brokers.push(broker);
  return broker;
}

afterEach(async () => {
  await Promise.all(brokers.map((b) => b.stop()));
  brokers.length = 0;
});

describe('topic49 P2-AK · 未知窗口的 Stop 事件不串话', () => {
  it('cc_unknown_*(windowId=null)不解锁 windowId=4 的等待者 → 超时', async () => {
    const dir = await makeDir();
    const broker = await makeBroker(dir);
    // 外部 claude:文件名 windowId 槽是 "unknown" → 解析为 null,cwd 与等待者相同
    await writeFile(
      join(dir, `cc_unknown_cli-x_${Date.now()}000.jsonl`),
      `${JSON.stringify({ session_id: 'cli-x', cwd: '/repo', event: 'stop' })}\n`,
      'utf8',
    );

    const result = await broker.awaitNext({
      windowId: 4,
      runner: 'cc',
      cwd: '/repo',
      timeoutMs: 300,
    });
    expect('status' in result && result.status === 'timeout').toBe(true);
  });

  it('真实 windowId(cc_4_*)的事件仍正常解锁 windowId=4(回归)', async () => {
    const dir = await makeDir();
    const broker = await makeBroker(dir);
    await writeFile(
      join(dir, `cc_4_cli-y_${Date.now()}000.jsonl`),
      `${JSON.stringify({ session_id: 'cli-y', cwd: '/repo', event: 'stop' })}\n`,
      'utf8',
    );

    const result = await broker.awaitNext({
      windowId: 4,
      runner: 'cc',
      cwd: '/repo',
      timeoutMs: 2000,
    });
    expect('status' in result && (result as { status?: string }).status === 'timeout').toBe(
      false,
    );
    expect('windowId' in result && result.windowId).toBe(4);
  });
});
