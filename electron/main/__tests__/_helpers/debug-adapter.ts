// 真 js-debug 适配器集成测试共用的准备与进程探针(debug-service / dap-teardown-mini / debug-adapter-smoke;
// 此前三处各抄一份,teardown-mini 还改用 `.cjs` 后缀加载 —— 与生产(scripts/fetch-debug-adapter 写
// `{"type":"commonjs"}` 标记)不是同一机制,而当年正是 `.cjs` 掩盖了 ESM 误判导致的真机崩溃)。
// electron/ 下测试不能从 src/ 导入(process-layering),故放在 electron 侧。
import { execFile as execFileCb } from 'node:child_process';
import { copyFile, cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sleep } from '../../lib/wait-at-most';

const execFile = promisify(execFileCb);

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export interface ProcessGroupEntry {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

/**
 * 把适配器目录复制到临时目录并写 `{"type":"commonjs"}`(同生产):仓库根 package.json 是 type:module,
 * 不加标记时 CJS 适配器会被当成 ESM 加载。返回临时目录(调用方负责删除)与入口路径。
 */
export async function prepareCommonJsAdapter(
  adapterPath: string,
  tmpPrefix: string,
): Promise<{ dir: string; adapterPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), tmpPrefix));
  await cp(path.dirname(adapterPath), dir, { recursive: true });
  const runnablePath = path.join(dir, path.basename(adapterPath));
  await copyFile(adapterPath, runnablePath);
  await writeFile(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  return { dir, adapterPath: runnablePath };
}

export async function processInfo(pid: number | undefined): Promise<ProcessInfo | null> {
  if (!pid || process.platform === 'win32') return null;
  try {
    const { stdout } = await execFile('ps', ['-o', 'pid=,ppid=,pgid=,command=', '-p', String(pid)]);
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    };
  } catch {
    return null;
  }
}

export async function pidsInProcessGroup(pgid: number): Promise<ProcessGroupEntry[]> {
  if (!pgid || process.platform === 'win32') return [];
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,pgid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? '' }
          : null;
      })
      .filter((entry): entry is ProcessGroupEntry => entry !== null)
      .filter((entry) => entry.pgid === pgid);
  } catch {
    return [];
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询(100ms)直到 pids 全部退出或超时;返回超时仍存活的 pid。 */
export async function waitForDead(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return [];
    await sleep(100);
  }
  return pids.filter(pidAlive);
}
