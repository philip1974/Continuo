// 真 js-debug 适配器集成测试共用的准备与进程探针(debug-service / dap-teardown-mini / debug-adapter-smoke;
// 此前三处各抄一份,teardown-mini 还改用 `.cjs` 后缀加载 —— 与生产(scripts/fetch-debug-adapter 写
// `{"type":"commonjs"}` 标记)不是同一机制,而当年正是 `.cjs` 掩盖了 ESM 误判导致的真机崩溃)。
// electron/ 下测试不能从 src/ 导入(process-layering),故放在 electron 侧。
import { execFile as execFileCb } from 'node:child_process';
import { cp, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sleep } from '../../../shared/wait-at-most';

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
 * 复现生产的加载环境:临时根目录放 `{"type":"module"}`(同仓库根 package.json),适配器目录复制到其下并写
 * `{"type":"commonjs"}` 标记(同 scripts/fetch-debug-adapter)。少了标记时 CJS 适配器会被当成 ESM 加载
 * 而崩溃 —— 只放在 os.tmpdir() 下(上级无 package.json)则无论有无标记都按 CJS 加载,测不出这个陷阱。
 * 返回临时根目录(调用方负责删除)与入口路径。
 */
export async function prepareCommonJsAdapter(
  adapterPath: string,
  tmpPrefix: string,
): Promise<{ dir: string; adapterPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), tmpPrefix));
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const adapterDir = path.join(dir, 'adapter');
  await cp(path.dirname(adapterPath), adapterDir, { recursive: true });
  await writeFile(path.join(adapterDir, 'package.json'), '{"type":"commonjs"}\n');
  return { dir, adapterPath: path.join(adapterDir, path.basename(adapterPath)) };
}

/** 真适配器用例共用的被调试程序:`scripts/debug-spike/fixture.ts` 编译出的 `.out/fixture.js`(gitignore,不随仓库走)。 */
export const DEBUG_SPIKE_FIXTURE_TIMEOUT_MS = 60_000;

const mtimeMs = async (file: string): Promise<number | null> => {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * 确保 `<spikeDir>/.out/fixture.js` 已由 `fixture.ts` 编译(缺或比源文件旧时跑一次 `tsc -p <spikeDir>/tsconfig.json`)。
 * CI 先跑同一条 tsc(ci.yml debug-spike job),这里只补新 worktree / 只复制了 `.adapter` 的本地环境;只在适配器存在、
 * 真适配器用例要跑时由其 beforeAll 调用,常规单测不付这次编译。返回编译出的路径;编译失败抛出带命令与输出的错误。
 */
export async function ensureDebugSpikeFixture(spikeDir: string): Promise<string> {
  const out = path.join(spikeDir, '.out/fixture.js');
  const [outTime, srcTime] = await Promise.all([mtimeMs(out), mtimeMs(path.join(spikeDir, 'fixture.ts'))]);
  if (outTime !== null && (srcTime === null || outTime >= srcTime)) return out;
  const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
  const tsconfig = path.join(spikeDir, 'tsconfig.json');
  try {
    await execFile(process.execPath, [tsc, '-p', tsconfig], { timeout: DEBUG_SPIKE_FIXTURE_TIMEOUT_MS });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `debug spike fixture 编译失败(真适配器用例需要 ${out}):tsc -p ${tsconfig}\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
    );
  }
  if ((await mtimeMs(out)) === null) throw new Error(`tsc -p ${tsconfig} 之后仍没有 ${out}`);
  return out;
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
