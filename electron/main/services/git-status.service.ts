// 资源管理器 git 状态(对齐 VSCode git 扩展:`git status` → 文件装饰;GitIgnoreDecorationProvider → 忽略项置灰)。
// 不依赖插件:宿主自己在工作区根跑只读 git 命令。非仓库 / 未装 git / 超时 / 输出超限 → null(静默,不报错)。
//
// 安全:
// - execFile + 参数数组(不经 shell);cwd 由调用方传入本窗口已登记的工作区根(git.ipc 取 getWorkspaceRoot,renderer 不自报)。
// - GIT_OPTIONAL_LOCKS=0:status 不写回 index、不抢 index.lock(用户同时在终端跑 git 不会撞锁),也不触发写 index 的 hook。
// - 同 plugin-fs 的 git 兜底 env:剥离宿主机密与改读别处仓库的 GIT_*、强制 core.fsmonitor=false、禁止一切传输(惰性拉取)。
// - Windows 上 git 只在 PATH 绝对目录中解析(不执行工作区里的 git.exe)。
// 资源:单条命令超时 + 输出上限(SIGKILL);全局并发上限;同一根至多一个在跑 + 一个排队(期间的请求合并到排队那次)。
// BDD: src/__tests__/explorer-git-decorations/

import { execFile } from 'node:child_process';
import {
  GIT_STATUS_STALE,
  type GitStatusEntry,
  type GitStatusKind,
  type GitStatusResult,
  type GitStatusSnapshot,
} from '../../shared/git-status';
import {
  GIT_OFFLINE_ENV,
  mergeSpawnEnv,
  resolveSpawnCommand,
  stripGitRepoRedirectEnv,
  stripInternalSecretEnv,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';

/** 单条 git 命令超时(大仓库首次 status 可能较慢;超时即本轮无装饰,下次触发再试)。 */
export const GIT_STATUS_TIMEOUT_MS = 10_000;
/** status 输出上限(字节);超出视为失败。 */
export const GIT_STATUS_MAX_BUFFER = 32 * 1024 * 1024;
/** 返回给 renderer 的条目上限(超出截断,防超大 IPC 载荷)。 */
export const GIT_STATUS_MAX_ENTRIES = 100_000;
/** 全局同时在跑的 git 查询上限(多窗口 / 多根)。 */
export const GIT_STATUS_MAX_CONCURRENT = 2;

/** 跑一条 git 命令,返回 stdout;非零退出 / 超时 / 超限 / 找不到 git → reject。 */
export type GitExec = (args: readonly string[], cwd: string) => Promise<string>;

export function gitStatusEnv(): NodeJS.ProcessEnv {
  return mergeSpawnEnv(withGitHardeningEnv(stripGitRepoRedirectEnv(stripInternalSecretEnv(process.env))), {
    ...GIT_OFFLINE_ENV,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
}

export const execGit: GitExec = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    const env = gitStatusEnv();
    execFile(
      resolveSpawnCommand('git', env),
      [...args],
      {
        cwd,
        env,
        timeout: GIT_STATUS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_STATUS_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

interface Classified {
  readonly kind: GitStatusKind;
  readonly letter: string;
  /** 同一路径多条记录时的优先级(VSCode 依次收集 index → untracked → workingTree → merge,后者覆盖前者)。 */
  readonly rank: number;
}

function fromCode(code: string): { kind: GitStatusKind; letter: string } | null {
  switch (code) {
    case 'M':
      return { kind: 'modified', letter: 'M' };
    case 'T':
      return { kind: 'modified', letter: 'T' };
    case 'A':
      return { kind: 'added', letter: 'A' };
    case 'D':
      return { kind: 'deleted', letter: 'D' };
    case 'R':
      return { kind: 'renamed', letter: 'R' };
    case 'C':
      return { kind: 'renamed', letter: 'C' };
    default:
      return null;
  }
}

/** porcelain v1 的 XY 状态码 → 装饰(工作区一侧优先于暂存区一侧,冲突最高)。无法识别 → null。 */
export function classifyXY(xy: string): Classified | null {
  if (xy === '!!') return { kind: 'ignored', letter: '', rank: -1 };
  if (xy === '??') return { kind: 'untracked', letter: 'U', rank: 1 };
  if (CONFLICT_XY.has(xy)) return { kind: 'conflict', letter: '!', rank: 3 };
  const work = fromCode(xy[1] ?? ' ');
  if (work) return { ...work, rank: 2 };
  const index = fromCode(xy[0] ?? ' ');
  if (index) return { ...index, rank: 0 };
  return null;
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出。路径相对仓库根;prefix = 工作区根相对仓库根的前缀(`rev-parse --show-prefix`,
 * 以 `/` 结尾或为空)。只保留工作区根内的条目并去掉前缀;覆盖整个工作区根的目录条目(根本身在未跟踪 / 忽略目录内)记为 ''。
 * 重命名 / 复制记录(`XY 新路径\0旧路径\0`)只装饰新路径。同一路径多条(如 `D ` + `??`)按 rank 取高者。
 */
export function parsePorcelainZ(stdout: string, prefix: string): GitStatusEntry[] {
  const byPath = new Map<string, Classified>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4 || token[2] !== ' ') continue;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++; // 跳过旧路径
    const c = classifyXY(xy);
    if (!c) continue;
    let rel: string;
    if (path.startsWith(prefix)) {
      rel = path.slice(prefix.length);
    } else if (path.endsWith('/') && prefix.startsWith(path)) {
      rel = '';
    } else {
      continue;
    }
    const prev = byPath.get(rel);
    if (!prev || c.rank > prev.rank) byPath.set(rel, c);
    if (byPath.size >= GIT_STATUS_MAX_ENTRIES) break;
  }
  const out: GitStatusEntry[] = [];
  for (const [p, c] of byPath) out.push([p, c.kind, c.letter]);
  return out;
}

/** 在 root 跑 rev-parse + status;任何失败 → null。 */
export async function queryGitStatus(root: string, exec: GitExec = execGit): Promise<GitStatusSnapshot | null> {
  let head: string;
  try {
    head = await exec(['rev-parse', '--is-inside-work-tree', '--show-prefix'], root);
  } catch {
    return null;
  }
  const lines = head.split('\n');
  if (lines[0]?.trim() !== 'true') return null;
  const prefix = (lines[1] ?? '').replace(/\r$/, '');
  let out: string;
  try {
    out = await exec(
      ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal', '--', '.'],
      root,
    );
  } catch {
    return null;
  }
  return { root, entries: parsePorcelainZ(out, prefix) };
}

export interface GitStatusService {
  status(root: string): Promise<GitStatusSnapshot | null>;
}

export function createGitStatusService(
  exec: GitExec = execGit,
  maxConcurrent: number = GIT_STATUS_MAX_CONCURRENT,
): GitStatusService {
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  const running = new Map<string, Promise<GitStatusSnapshot | null>>();
  const queued = new Map<string, Promise<GitStatusSnapshot | null>>();

  return {
    status(root) {
      const pending = queued.get(root);
      if (pending) return pending;
      const prev = running.get(root);
      const self: { p?: Promise<GitStatusSnapshot | null> } = {};
      const p = (async () => {
        await prev; // 无在跑时也让出一拍:此后 self.p 已赋值
        queued.delete(root);
        running.set(root, self.p!);
        await acquire();
        try {
          return await queryGitStatus(root, exec);
        } finally {
          release();
          if (running.get(root) === self.p) running.delete(root);
        }
      })();
      self.p = p;
      queued.set(root, p);
      return p;
    },
  };
}

/**
 * git:status 处理:根取自发送窗口的工作区登记(renderer 不能指定 cwd)。renderer 带上它期望的根:与登记根不符(换根时
 * 子组件 effect 先于 App 的 notify-root 跑到这里,或从「未打开文件夹」首次打开、登记尚未到达)→ STALE,不跑 git。
 */
export function makeGitStatusHandler(
  service: GitStatusService,
  getRoot: (windowId: number) => string | null,
) {
  return (win: { readonly id: number }, expectedRoot: string): Promise<GitStatusResult> => {
    const root = getRoot(win.id);
    return root === null || root !== expectedRoot ? Promise.resolve(GIT_STATUS_STALE) : service.status(root);
  };
}
