// 关闭终端后主进程不残留 PTY 句柄(BDD:README.md)。走真实 node-pty + server-node SessionManager(同主进程),
// 不 mock;在本测试进程里数 PTY 相关 fd,开 N 个再关掉后须回到基线。node-pty 1.1.0 上每个终端漏
// 1 ptmx + 1 revoked 从端 + 1 KQUEUE,此规范在该版本上失败。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@continuo-terminal/server-node';

const N = 6;
const SUPPORTED =
  (process.platform === 'darwin' && existsSync('/usr/sbin/lsof')) ||
  (process.platform === 'linux' && existsSync('/proc/self/fd'));
const CAN_RUN = SUPPORTED && existsSync('/bin/sh');

interface PtyFds {
  readonly master: number;
  readonly slave: number;
  readonly kqueue: number;
}

function countPtyFds(): PtyFds {
  if (process.platform === 'linux') {
    let master = 0;
    let slave = 0;
    for (const fd of readdirSync('/proc/self/fd')) {
      let target: string;
      try {
        target = readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        continue; // 读目录本身的 fd 等已关闭
      }
      if (target === '/dev/ptmx') master++;
      else if (target.startsWith('/dev/pts/')) slave++;
    }
    return { master, slave, kqueue: 0 };
  }
  const out = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-p', String(process.pid)], { encoding: 'utf8' });
  const lines = out.split('\n');
  return {
    master: lines.filter((l) => l.includes('/dev/ptmx')).length,
    slave: lines.filter((l) => /\/dev\/ttys\d+|\(revoked\)/.test(l)).length,
    kqueue: lines.filter((l) => /\bKQUEUE\b/.test(l)).length,
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

/** 轮询到 fd 数回到基线(异步关闭有延迟);超时返回最后一次计数,交给断言报差值。 */
async function settleTo(baseline: PtyFds, timeoutMs = 8_000): Promise<PtyFds> {
  let now = countPtyFds();
  const deadline = Date.now() + timeoutMs;
  while (
    (now.master > baseline.master || now.slave > baseline.slave || now.kqueue > baseline.kqueue) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 200));
    now = countPtyFds();
  }
  return now;
}

let sm: SessionManager | null = null;
afterEach(async () => {
  await sm?.dispose();
  sm = null;
});

describe.skipIf(!CAN_RUN)('terminal-pty-fd-leak · 关闭终端后主进程不残留 PTY 句柄', () => {
  it(`spawn ${N} 个真实 PTY 再 SIGKILL 关闭(⌘W 关终端)→ PTY 相关 fd 回到基线`, async () => {
    sm = new SessionManager();
    const baseline = countPtyFds();
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const { session_id } = await sm.create({ shell: '/bin/sh', cwd: tmpdir() });
      ids.push(session_id);
    }
    // 确认真的开出了 PTY(防止计数手段失效导致假绿)
    expect(countPtyFds().master - baseline.master).toBeGreaterThanOrEqual(N);
    for (const id of ids) await sm.kill({ session_id: id, signal: 'SIGKILL' });
    expect(await settleTo(baseline)).toEqual(baseline);
  }, 30_000);

  it(`spawn ${N} 个真实 PTY 让 shell 自行 exit(exit 后关面板)→ PTY 相关 fd 回到基线`, async () => {
    const exits = new Set<string>();
    sm = new SessionManager({ onExit: (id) => exits.add(id) });
    const baseline = countPtyFds();
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const { session_id } = await sm.create({ shell: '/bin/sh', cwd: tmpdir() });
      ids.push(session_id);
    }
    expect(countPtyFds().master - baseline.master).toBeGreaterThanOrEqual(N);
    for (const id of ids) await sm.sendInput({ session_id: id, data: 'exit\r' });
    await waitFor(() => ids.every((id) => exits.has(id)), 10_000);
    expect(ids.filter((id) => !exits.has(id))).toEqual([]);
    expect(await settleTo(baseline)).toEqual(baseline);
  }, 30_000);
});
