// 服务实现: MCP terminal.await_stop_hook + bundled install_stop_hook。
// 设计来源: ported from Nous packages/shells/shell/src/external-cli-bridge/{hook-completion-waiter,parse-payload,settings-templates}.ts
// 与 Nous 差异:
//  - app-singleton broker (Continuo 端只一个实例,不是 per-call)
//  - matched-only unlink (P0-3) + maxEntries=500 + maxAgeMs=600_000 stale cleanup (P1-1)
//  - ambiguity guard (P0-1): 同 (windowId, runner, cwd) 第二 pending → AWAIT_STOP_HOOK_ALREADY_PENDING
//  - Codex hook filename 加 windowId (P0-4)
//  - settings merge 不 parse TOML, block-level regex + marker-only path drift (P1-3)
//  - raw default omit (P1-4) — broker 返回完整 payload, awaitStopHookTool.run() 仅 input.include_raw=true 时加 output
//  - start fail degrade (P2-1) — broker.start throw → 上层 startMcpHost 不注册 tool

import { watch } from 'node:fs';
import {
  copyFile,
  mkdir,
  opendir,
  stat,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile } from '../ipc/fs/atomic-write';

import {
  awaitStopHookInputSchema,
  MCP_TOOL_AWAIT_STOP_HOOK,
  type AwaitStopHookInput,
  type AwaitStopHookOutput,
} from '../../shared/mcp-terminal-schemas';
import { ERROR_CODES } from '../../shared/error-codes';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { truncateSessionIdForEcho } from '../lib/session-id-echo';
import type { McpCallCtx, McpToolDef } from './mcp-host.service';
import { z } from 'zod';
import { SESSION_ID_MAX } from '../../shared/session-id-limits';

// 边界(E203,mcp-tools-terminal 同族):协议 awaitStopHookInputSchema 的 session_id 仅 min(1) 无上限。
// 1MB session_id 校验通过后进 broker / Map / 错误回显路径(回显已截断 E151,但运行期仍处理超长 key)。
// .extend 收窄 session_id 加 .max(SESSION_ID_MAX),保留 timeout_sec/include_raw 的 .default()(z.output 不变)。
const awaitStopHookBoundedSchema = awaitStopHookInputSchema.extend({
  session_id: z.string().min(1).max(SESSION_ID_MAX),
});

export type RunnerKind = 'cc' | 'codex' | 'unknown';

interface TerminalSessionMetaLike {
  readonly id: string;
  readonly cwd: string;
  readonly agentLabel?: string;
  readonly autorun?: string;
}

interface NormalizedPayload {
  readonly runner: 'cc' | 'codex';
  readonly cliSessionId: string;
  readonly turnId: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  readonly lastAssistantMessage: string | null;
  readonly raw: Record<string, unknown>;
}

interface AwaitFilter {
  readonly windowId: number;
  readonly runner: 'cc' | 'codex';
  readonly cwd: string;
  readonly timeoutMs: number;
}

const HOOK_FILE_PREFIX = { cc: 'cc_', codex: 'codex_' } as const;
const BROKER_DEFAULTS = {
  maxEntries: 500,
  maxAgeMs: 600_000,
  cleanupIntervalMs: 60_000,
} as const;

// 边界(E26,E18/E20/E24 兄弟):stop-hook event 文件来自外部 CLI(claude/codex)写入,内容完全
// 不可控。ingestFile 此前直接 readFile(.., 'utf8') 整块读入再 JSON.parse,无文件大小上限;解析后的
// 完整 raw 还被缓冲在 buffered entry(最多 maxEntries=500 条)并在 include_raw 时跨 MCP 传回 client。
// 畸形 hook 文件或异常 CLI 输出可让主进程整块读入超大 JSON → 内存峰值 + 事件循环长时间阻塞 +
// buffered 累积放大。ingestFile 在 stat 之后(fileStat 已就绪,零额外 syscall)即按 size 拦截:超限
// 当作损坏文件隔离(标 processed + unlink),不读不解析不缓冲。该上限同时反向钳住下游 raw /
// last_assistant_message / include_raw payload 的字节数(全部派生自被钳的 jsonText)。
const MAX_HOOK_FILE_BYTES = 1024 * 1024; // 1 MiB:stop-hook 是小元数据 JSON,留足余量
// 边界(E150):buffered 仅按条数(maxEntries=500)淘汰,每条可达 ~1MiB(MAX_HOOK_FILE_BYTES)→
// main 进程常驻最坏 ~500MiB。加 buffered **总字节预算**:超预算时按 FIFO 淘汰最旧,把常驻内存
// 钳到 budget(与条数上限取双闸,谁先到先淘汰)。
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024; // buffered 总字节预算(远超正常元数据量)
export const FIELD_MAX = 1024; // session_id/turn_id/cwd/transcript_path 标识/路径字段上限
export const LAST_MSG_MAX = 64 * 1024; // last_assistant_message 正文上限

// 边界(E83,E82/E30 数量上限族):hook 目录文件数上限。maxEntries 只限解析后 buffer、
// MAX_HOOK_FILE_BYTES 只限单文件大小,目录文件**数量**无界 —— 畸形/堆积的 cc_*/codex_* 文件让
// start() 初始扫描 + 每轮 cleanupStale 被海量 stat/read/parse/unlink 拖垮(每文件 stat+read+parse+
// unlink 才是主导开销),主进程 I/O/CPU 被外部目录状态放大。每轮枚举后截断到 N 候选,超限告警 +
// 留给后续轮继续清理(cleanupStale 周期跑,每轮再削 N)。start 扫描与 cleanupStale 共用。
const MAX_HOOK_DIR_ENTRIES = 4096;

async function readHookDirCapped(dir: string, max: number): Promise<string[]> {
  // 边界(E212,E211 同模式):用 opendir 流式枚举,累计到 max 即关闭返回 —— 不用 readdir 一次性把
  // 堆积/畸形 hook 目录的所有文件名物化进内存(MAX_HOOK_DIR_ENTRIES 只限后续处理,挡不住枚举阶段)。
  // for await 在 break/完成时自动 close Dir。语义保持:>max 时截断到 max 个 + 告警。
  let dirHandle;
  try {
    dirHandle = await opendir(dir);
  } catch {
    return []; // 目录不存在/不可读
  }
  const names: string[] = [];
  let truncated = false;
  for await (const dirent of dirHandle) {
    if (names.length >= max) {
      truncated = true; // 还有第 max+1 项 → 确实超限
      break;
    }
    names.push(dirent.name);
  }
  if (truncated) {
    console.warn(`[hook-broker] dir entries truncated to ${max}: ${dir}`);
  }
  // opendir 流式枚举顺序不保证(与旧 readdir 可能不同),而 ingest 顺序决定同 session 多 hook 文件
  // 谁先入 buffered(首个匹配胜出)。排序使枚举顺序确定(旧 readdir 顺序本是未定义),消除"谁胜出"
  // 的平台/实现相关性。
  names.sort();
  return names;
}

export function inferRunner(session: TerminalSessionMetaLike): RunnerKind {
  const label = session.agentLabel?.toLowerCase() ?? '';
  if (label === 'cc' || label === 'claude' || label === 'claude-code') {
    return 'cc';
  }
  if (label === 'codex') return 'codex';

  const autorun = session.autorun?.toLowerCase() ?? '';
  const match = /^(claude|codex)(?:\s|$)/.exec(autorun);
  if (match?.[1] === 'claude') return 'cc';
  if (match?.[1] === 'codex') return 'codex';
  return 'unknown';
}

export function inferRunnerFromFilename(
  fileName: string,
): 'cc' | 'codex' | null {
  if (fileName.startsWith(HOOK_FILE_PREFIX.cc)) return 'cc';
  if (fileName.startsWith(HOOK_FILE_PREFIX.codex)) return 'codex';
  return null;
}

export function parseStopPayload(
  runner: 'cc' | 'codex',
  _fileName: string,
  jsonText: string,
): NormalizedPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const r = raw as Record<string, unknown>;
  // 边界(E150):各字段长度上限。MAX_HOOK_FILE_BYTES 已把整文件钳到 1MiB,但单字段(尤其
  // last_assistant_message)仍可接近 1MiB,进 buffered/非 raw MCP 响应/日志放大。标识/路径上限 1024,
  // 正文上限 64KiB(超出截断;不影响匹配,匹配只看 runner/windowId/cwd 前缀且 cwd 已限长)。
  const capStr = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.length > 0
      ? v.length > max
        ? v.slice(0, max)
        : v
      : null;

  const sessionId = capStr(r.session_id, FIELD_MAX);
  if (sessionId === null) return null;

  return {
    runner,
    cliSessionId: sessionId,
    turnId: capStr(r.turn_id, FIELD_MAX),
    cwd: capStr(r.cwd, FIELD_MAX),
    transcriptPath: capStr(r.transcript_path, FIELD_MAX),
    lastAssistantMessage: capStr(r.last_assistant_message, LAST_MSG_MAX),
    raw: r,
  };
}

interface BufferedEntry {
  readonly fileName: string;
  readonly payload: NormalizedPayload;
  readonly windowId: number | null;
  readonly ingestedAt: number;
  /** 边界(E150):该 entry 的源 JSON 字节数,用于 buffered 总字节预算淘汰。 */
  readonly byteSize: number;
}

interface PendingWaiter {
  readonly filter: AwaitFilter;
  readonly resolve: (entry: BufferedEntry) => void;
  readonly reject: (err: Error) => void;
  readonly key: string;
  timer: NodeJS.Timeout | null;
}

type AwaitNextResult =
  | BufferedEntry
  | { readonly status: 'timeout'; readonly elapsedMs: number };

function filterKey(filter: AwaitFilter): string {
  return `${filter.windowId}|${filter.runner}|${filter.cwd}`;
}

function parseFilenameForWindowId(fileName: string): number | null {
  const match = /^(cc|codex)_([0-9]+)_/.exec(fileName);
  if (match?.[2] === undefined) return null;
  return Number.parseInt(match[2], 10);
}

export interface HookFileBroker {
  start(): Promise<void>;
  awaitNext(filter: AwaitFilter): Promise<AwaitNextResult>;
  /**
   * 提前结束某窗口的所有 pending await_stop_hook 等待者(窗口关闭时调用)。
   * 否则它们会一直挂到 timeout_sec(最长 600s)才靠自身 timer 自愈(审计 #3)。
   * 返回被取消的等待者数量(便于测试断言)。
   */
  cancelByWindow(windowId: number): number;
  stop(): Promise<void>;
  readonly hookEventsDir: string;
}

export interface HookWatcher {
  close(): void;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

export type HookWatchFactory = (
  hookEventsDir: string,
  onFile: (fileName: string) => void,
) => HookWatcher;

export function createHookFileBroker(
  hookEventsDir: string,
  config: {
    maxEntries?: number;
    maxAgeMs?: number;
    cleanupIntervalMs?: number;
    /** 边界(E83):每轮目录枚举候选上限(默认 MAX_HOOK_DIR_ENTRIES);可注入便于测试。 */
    maxDirEntries?: number;
    /** 边界(E150):buffered 总字节预算(默认 MAX_BUFFERED_BYTES);可注入便于测试。 */
    maxBufferedBytes?: number;
    /** 测试可注入 watcher,避免 Windows CI 触发 Node/libuv fs.watch 原生断言。 */
    watchFactory?: HookWatchFactory;
  } = {},
): HookFileBroker {
  const maxEntries = config.maxEntries ?? BROKER_DEFAULTS.maxEntries;
  const maxAgeMs = config.maxAgeMs ?? BROKER_DEFAULTS.maxAgeMs;
  const cleanupIntervalMs =
    config.cleanupIntervalMs ?? BROKER_DEFAULTS.cleanupIntervalMs;
  const maxDirEntries = config.maxDirEntries ?? MAX_HOOK_DIR_ENTRIES;
  const maxBufferedBytes = config.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const watchFactory =
    config.watchFactory ??
    ((dir, onFile) =>
      watch(
        dir,
        { persistent: false, encoding: 'utf8' },
        (_eventType, fileName) => {
          if (typeof fileName === 'string' && fileName.length > 0) {
            onFile(fileName);
          }
        },
      ));

  let watcher: HookWatcher | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;
  // race(R81):启动代际。start() 在 `await mkdir` 处让权,期间 stop()(stopped=true)或又一次
  // start() 可能插入;mkdir 返回后据此判定本次启动是否仍当前,过期则不 attach watcher/interval。
  let startGen = 0;
  // race(R90):ingest 代际,stop() 时 +1。ingestFile 在 stat/readFile 的 await 处让权,期间
  // stop()(清空 pending/buffered/processed)甚至 restart 可能发生;迟到的 ingestFile 若继续
  // processed.set/匹配 pending/buffered.push,会重污染已清空(或新一代)的状态,后续
  // await_stop_hook 误消费上一代 hook 事件。捕获本次 gen,每个 await 后复查 stopped + gen 未变。
  let ingestGen = 0;
  // fileName → 处理时刻(ms)。用 Map 而非 Set 以便在 cleanupStale 里按年龄淘汰,
  // 否则长开 app + 频繁 stop-hook(文件名带 ns 时间戳永远唯一)会单调膨胀(审计 P1)。
  const processed = new Map<string, number>();
  // 正在 ingest 中的文件名(读+解析期间)。防同一文件的并发 watch 事件重复 ingest;
  // 与 processed 分离,使读/解析失败的文件不被永久标记,允许写入完成后重试。
  const inFlight = new Set<string>();
  const buffered: BufferedEntry[] = [];
  let bufferedBytes = 0; // 边界(E150):buffered 当前总字节数(总字节预算淘汰用)
  const pendingByKey = new Map<string, PendingWaiter>();

  function matchesFilter(entry: BufferedEntry, filter: AwaitFilter): boolean {
    if (entry.payload.runner !== filter.runner) return false;
    // windowId 严格相等(fail-closed)。entry.windowId===null = 来源窗口未知:写文件时
    // CONTINUO_WINDOW_ID 未注入,典型是非 Continuo 托管的外部 claude/codex 在装了
    // managed Stop hook 的同一项目里跑。旧实现 null 当通配,会让这种外部 Stop 事件
    // (同 runner+cwd)串到某 Continuo 窗口的 await_stop_hook 等待者,泄漏他方
    // session_id/transcript_path/last_assistant_message。filter.windowId 类型恒为具体数,
    // 故 null entry 一律不匹配。windowId 正是文件名里做窗口隔离的字段,不该被 null 旁路。
    // 见第十三轮 P2-AK。
    if (entry.windowId !== filter.windowId) return false;
    if (entry.payload.cwd !== null && entry.payload.cwd !== filter.cwd) {
      return false;
    }
    return true;
  }

  async function ingestFile(fileName: string): Promise<void> {
    if (stopped || processed.has(fileName) || inFlight.has(fileName)) return;

    const runner = inferRunnerFromFilename(fileName);
    if (runner === null) return;

    // race(R90):捕获本次 ingest 代际,await 后据此丢弃过期(stop/restart 期间发起的)结果。
    const myGen = ingestGen;
    inFlight.add(fileName);
    try {
      const filePath = path.join(hookEventsDir, fileName);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(filePath);
      } catch {
        return; // 文件消失/不可读 → 不标 processed,允许后续 watch 事件重试
      }
      // race(R90):stat 期间若 stop()/restart → 本次已过期,不再写任何共享状态(processed/
      // unlink/pending/buffered),避免污染已清空或新一代的 broker 状态。
      if (stopped || myGen !== ingestGen) return;

      if (Date.now() - fileStat.mtimeMs > maxAgeMs) {
        processed.set(fileName, Date.now());
        void unlink(filePath).catch(() => {});
        return;
      }

      // 边界(E26):超大 hook 文件 = 损坏/异常 CLI 输出,绝不整块读入。标 processed + unlink
      // 隔离(同 maxAge 分支语义:不重试、不留残留),不读不解析不缓冲。fileStat 已就绪,零额外
      // syscall。该上限反向钳住下游 raw / last_assistant_message / include_raw 字节数。
      if (fileStat.size > MAX_HOOK_FILE_BYTES) {
        console.warn(
          `[hook-broker] dropping oversize hook file ${fileName} (${fileStat.size} bytes > ${MAX_HOOK_FILE_BYTES})`,
        );
        processed.set(fileName, Date.now());
        void unlink(filePath).catch(() => {});
        return;
      }

      // 边界(E162,stat-before-read TOCTOU 修正):上面的 fileStat.size 仅作早期快速丢弃;stat 与
      // 读取之间 hook JSON 可被替换/增长绕过 MAX_HOOK_FILE_BYTES,故实际读取用共享 readFileCappedFd
      // (单 fd open→fstat 同 inode→有界读),size 上限在读取的同一 fd 上权威生效。too-large 按既有
      // 语义 processed + unlink 隔离(不重试);读失败仍 return 保留重试。
      let read: Awaited<ReturnType<typeof readFileCappedFd>>;
      try {
        read = await readFileCappedFd(filePath, MAX_HOOK_FILE_BYTES);
      } catch {
        return; // 读失败/文件消失(写入未完成)→ 不标 processed/不 unlink,等下次事件重试
      }
      // race(R90):读取期间若 stop()/restart → 丢弃,不写共享状态(同上)。
      if (stopped || myGen !== ingestGen) return;
      if (read.tooLarge) {
        console.warn(
          `[hook-broker] dropping oversize hook file ${fileName} (${read.size} bytes > ${MAX_HOOK_FILE_BYTES})`,
        );
        processed.set(fileName, Date.now());
        void unlink(filePath).catch(() => {});
        return;
      }
      const jsonText = read.text as string; // tooLarge=false 时必为 string

      const payload = parseStopPayload(runner, fileName, jsonText);
      if (payload === null) {
        // 解析失败:文件可能正被 `cat >` 写入未完成。绝不 unlink(否则真实事件
        // 在内容到达前被删 → 永久丢失),也不标 processed,等写完后的 watch 事件
        // 重试。彻底损坏(写完仍无法解析)的残留由 cleanupStale 的目录清扫按
        // maxAge 兜底删除(审计 P1)。
        return;
      }

      // 解析成功才标 processed,防同名文件被重复 ingest。
      processed.set(fileName, Date.now());

      const entry: BufferedEntry = {
        fileName,
        payload,
        windowId: parseFilenameForWindowId(fileName),
        ingestedAt: Date.now(),
        byteSize: Buffer.byteLength(jsonText, 'utf8'),
      };

      for (const [key, pending] of pendingByKey) {
        if (matchesFilter(entry, pending.filter)) {
          pendingByKey.delete(key);
          if (pending.timer !== null) clearTimeout(pending.timer);
          void unlink(filePath).catch(() => {});
          pending.resolve(entry);
          return;
        }
      }

      buffered.push(entry);
      bufferedBytes += entry.byteSize;
      // 边界(E150):双闸淘汰 —— 条数超 maxEntries 或总字节超 MAX_BUFFERED_BYTES,FIFO 淘汰最旧,
      // 把 buffered 常驻内存钳到预算(防 500×1MiB ≈ 500MiB)。至少保留 1 条(刚 push 的)。
      while (
        buffered.length > 1 &&
        (buffered.length > maxEntries || bufferedBytes > maxBufferedBytes)
      ) {
        const dropped = buffered.shift();
        if (dropped !== undefined) {
          bufferedBytes -= dropped.byteSize;
          void unlink(path.join(hookEventsDir, dropped.fileName)).catch(() => {});
        }
      }
    } finally {
      inFlight.delete(fileName);
    }
  }

  async function cleanupStale(): Promise<void> {
    const now = Date.now();
    for (let i = buffered.length - 1; i >= 0; i -= 1) {
      const entry = buffered[i];
      if (entry !== undefined && now - entry.ingestedAt > maxAgeMs) {
        const stale = buffered.splice(i, 1)[0];
        if (stale !== undefined) {
          bufferedBytes -= stale.byteSize; // 边界(E150):同步 buffered 字节计数
          void unlink(path.join(hookEventsDir, stale.fileName)).catch(() => {});
        }
      }
    }
    // 淘汰 processed 去重记录:留 2x maxAgeMs 余量,确保对应文件早已被 unlink
    // (文件名唯一,不会再触发 watch 重新 ingest)。防 Set 无界增长。
    const processedTtl = maxAgeMs * 2;
    for (const [fileName, addedAt] of processed) {
      if (now - addedAt > processedTtl) processed.delete(fileName);
    }
    // 目录清扫:删除超过 maxAgeMs 的孤儿文件 —— 即解析失败后被保留(等重试)但
    // 始终无法解析的残留、或无 session_id 的完整但不可用文件。buffered/inFlight
    // 中的文件跳过(前者等消费、后者正处理)。这是"不在解析失败时立即 unlink"的
    // 兜底,避免长会话里此类文件累积。
    try {
      const names = await readHookDirCapped(hookEventsDir, maxDirEntries); // 边界(E83):有界枚举
      for (const name of names) {
        if (inferRunnerFromFilename(name) === null) continue;
        if (inFlight.has(name)) continue;
        if (buffered.some((e) => e.fileName === name)) continue;
        const p = path.join(hookEventsDir, name);
        try {
          const s = await stat(p);
          if (now - s.mtimeMs > maxAgeMs) {
            await unlink(p).catch(() => {});
            processed.delete(name);
          }
        } catch {
          // ignore per-file races
        }
      }
    } catch {
      // ignore directory read races
    }
  }

  return {
    hookEventsDir,
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      const myGen = ++startGen;
      await mkdir(hookEventsDir, { recursive: true });
      // race(R81):mkdir 期间若 stop()(stopped=true)或又一次 start()(startGen 前进)插入,本次
      // 是过期启动 → 直接返回,不 attach watcher/interval。否则 broker 已停却"复活":watcher +
      // cleanupTimer 泄漏(stop 已跑过、不会再清),且 stopped 态与实际资源不一致,后续 hook 文件
      // 仍被 ingest。started/stopped 已由插入的 stop()/start() 维护,此处只负责不接资源。
      if (stopped || myGen !== startGen) return;

      // race(R3):必须先 attach watcher 再做存量扫描。此前顺序相反(先 readdir 扫描、再 watch),
      // 扫描完成与 watcher 注册之间写入的 stop-hook 事件文件既不在初始扫描里、也不触发 watcher
      // → 永久漏事件,terminal.await_stop_hook 假超时。现在:watcher 先就位捕获扫描期间/之后的
      // 新文件,readdir 再补扫 watch 前已存在的文件;两者重叠的文件由 ingestFile 经
      // processed/inFlight 去重(幂等),无双 ingest。
      watcher = watchFactory(hookEventsDir, (fileName) => void ingestFile(fileName));
      watcher.on?.('error', () => {});
      const myWatcher = watcher; // race(R108):捕获本次 start 创建的 watcher,供过期时清理

      try {
        const entries = await readHookDirCapped(hookEventsDir, maxDirEntries); // 边界(E83):有界枚举
        for (const name of entries) {
          await ingestFile(name);
        }
      } catch {
        // Ignore startup directory races; watcher handles later files.
      }

      // race(R108,R81/R90 同族):初始 readdir/ingestFile 扫描在 await 处让权,期间 stop()
      // (stopped=true)或又一次 start()(startGen 前进)可能插入。此时本次已过期 → 绝不创建
      // cleanupTimer:否则 stop() 当时看不到尚未创建的 timer、清不掉,迟到的 setInterval 泄漏,
      // 甚至在 broker 已停/重启后继续跑 stale cleanupStale 污染新生命周期;新 start 情况下还会
      // 用旧 timer 引用覆盖新 start 的 cleanupTimer(新 timer 引用丢失、stop 清不到)。同时关掉
      // 本次创建的 watcher 防孤儿泄漏:stop() 情况它已被关+置 null(close 幂等);新 start 覆盖了
      // 模块 watcher 引用时,只关我们这只孤儿、不动当前 ref。
      if (stopped || myGen !== startGen) {
        try {
          myWatcher.close();
        } catch {
          /* close 幂等 */
        }
        if (watcher === myWatcher) watcher = null;
        return;
      }

      cleanupTimer = setInterval(() => void cleanupStale(), cleanupIntervalMs);
    },
    awaitNext(filter) {
      return new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error('broker stopped'));
          return;
        }

        const key = filterKey(filter);
        if (pendingByKey.has(key)) {
          reject(
            Object.assign(
              new Error(
                'await_stop_hook already pending for same (windowId, runner, cwd)',
              ),
              { code: ERROR_CODES.AWAIT_STOP_HOOK_ALREADY_PENDING },
            ),
          );
          return;
        }

        for (let i = 0; i < buffered.length; i += 1) {
          const hit = buffered[i];
          if (hit !== undefined && matchesFilter(hit, filter)) {
            buffered.splice(i, 1);
            bufferedBytes -= hit.byteSize; // 边界(E150):同步 buffered 字节计数
            void unlink(path.join(hookEventsDir, hit.fileName)).catch(() => {});
            resolve(hit);
            return;
          }
        }

        const startedAt = Date.now();
        const pending: PendingWaiter = {
          filter,
          key,
          resolve,
          reject,
          timer: null,
        };
        pending.timer = setTimeout(() => {
          pendingByKey.delete(key);
          resolve({ status: 'timeout', elapsedMs: Date.now() - startedAt });
        }, filter.timeoutMs);
        pendingByKey.set(key, pending);
      });
    },
    cancelByWindow(windowId) {
      let cancelled = 0;
      for (const [key, pending] of pendingByKey) {
        if (pending.filter.windowId !== windowId) continue;
        pendingByKey.delete(key);
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(
          new Error('await_stop_hook cancelled: owner window closed'),
        );
        cancelled += 1;
      }
      return cancelled;
    },
    async stop() {
      stopped = true;
      started = false;
      ingestGen += 1; // race(R90):invalidate 在途 ingestFile,迟到结果不再污染已清空状态
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          // ignore close races
        }
        watcher = null;
      }
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      for (const [, pending] of pendingByKey) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error('broker stopped'));
      }
      pendingByKey.clear();
      buffered.length = 0;
      bufferedBytes = 0; // 边界(E150):同步 buffered 字节计数
      processed.clear();
    },
  };
}

type InstallStopHookResult = {
  readonly installed: boolean;
  readonly reason?:
    | 'already-installed'
    | 'parse-error'
    | 'read-error'
    | 'config-too-large'
    | 'unknown-runner'
    | 'no-cwd'
    | 'unrecognized-existing-stop-hook';
};

// 边界(E66,E26 同款 / E18 stat-before-read 族):安装 stop-hook 时要读用户工作区的配置文件
// (.claude/settings.local.json / .codex/config.toml)—— 这是工作区外部输入。此前两处直接
// readFile(.., 'utf8') 整块读入,无大小上限:畸形/超大配置会让 main 进程在装 hook 时内存/CPU
// 峰值,.codex/config.toml 还会让 regex/replace 在超大文本上跑并构造更大的写入串。共用 capped-read
// helper:先 stat.size 拦,超限不进 parse/regex/atomicWrite。E26 已给 ingestFile 的 hook 输出文件
// 加过同款 cap,这两处配置读入是其平行入口。
const MAX_CONFIG_FILE_BYTES = 1024 * 1024; // 1 MiB:stop-hook 配置是小文本,留足余量

type CappedConfigRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' } // ENOENT → 新建
  | { readonly kind: 'too-large' }
  | { readonly kind: 'read-error' };

// 边界(E162,E66 stat-before-read TOCTOU 修正):此前 `stat(path).size` 预检 + `readFile(path)` 两次
// 独立路径解析,检查与读取之间配置可被替换/增长绕过 MAX_CONFIG_FILE_BYTES。改用共享 readFileCappedFd
// (单 fd open→fstat 同 inode→有界读)。语义保持:open ENOENT→missing(新建);其他 open 错误→
// read-error(不能当空配置→见两 merge 函数的「读失败当空→写覆盖」注释);too-large→too-large。
async function readConfigCapped(filePath: string): Promise<CappedConfigRead> {
  let read: Awaited<ReturnType<typeof readFileCappedFd>>;
  try {
    read = await readFileCappedFd(filePath, MAX_CONFIG_FILE_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'read-error' };
  }
  if (read.tooLarge) return { kind: 'too-large' };
  return { kind: 'ok', text: read.text as string };
}

export async function installStopHookForSession(
  cwd: string,
  runner: RunnerKind,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  if (cwd.length === 0) return { installed: false, reason: 'no-cwd' };
  if (runner === 'unknown') {
    return { installed: false, reason: 'unknown-runner' };
  }
  if (runner === 'cc') return mergeClaudeCodeSettings(cwd, hookEventsDir);
  return mergeCodexConfig(cwd, hookEventsDir);
}

async function mergeClaudeCodeSettings(
  cwd: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let existing: Record<string, unknown> = {};
  let fileExists = false;

  // 边界(E66):stat.size 预检的 capped-read。too-large/read-error 直接 fail-fast,不进
  // JSON.parse / atomicWrite。read-error 同既有「读失败当空→写覆盖」族:不能当空配置覆盖。
  const read = await readConfigCapped(settingsPath);
  if (read.kind === 'too-large') {
    return { installed: false, reason: 'config-too-large' };
  }
  if (read.kind === 'read-error') {
    return { installed: false, reason: 'read-error' };
  }
  if (read.kind === 'ok') {
    fileExists = true;
    try {
      const parsed = JSON.parse(read.text) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      return { installed: false, reason: 'parse-error' };
    }
  }
  // kind === 'missing' → fileExists 保持 false,新建

  const hooks =
    existing.hooks !== null &&
    typeof existing.hooks === 'object' &&
    !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const stopArr = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];

  for (const entry of stopArr) {
    const inner = (entry as { hooks?: unknown[] } | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const marker = (hook as { _continuo_managed?: unknown })._continuo_managed;
      const command = (hook as { command?: unknown }).command;
      if (
        marker === true &&
        typeof command === 'string' &&
        command.includes('CONTINUO_HOOK_EVENTS_DIR')
      ) {
        return { installed: false, reason: 'already-installed' };
      }
    }
  }

  if (fileExists) {
    await copyFile(settingsPath, `${settingsPath}.continuo-bak.${Date.now()}`);
  } else {
    await mkdir(path.dirname(settingsPath), { recursive: true });
  }

  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'cc_${CONTINUO_WINDOW_ID:-unknown}_${CLAUDE_CODE_SESSION_ID:-unknown}_$(date +%s%N).jsonl"';

  stopArr.push({
    hooks: [{ type: 'command', command, _continuo_managed: true }],
  });
  const next = { ...existing, hooks: { ...hooks, Stop: stopArr } };
  // crash-safe 原子写:裸 writeFile 先 truncate 用户真实配置,写入中途崩溃/磁盘满会把
  // .claude/settings.local.json 留成空/半截(.continuo-bak 备份需手工恢复)。与 R4
  // plugin-fs writeFile / plugin-data 的原子写策略对齐。(codex 复审 loop R6)
  await atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { installed: true };
}

async function mergeCodexConfig(
  cwd: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const configPath = path.join(cwd, '.codex', 'config.toml');
  let text = '';
  let fileExists = false;
  // 边界(E66,同 mergeClaudeCodeSettings):stat.size 预检的 capped-read,超大不进 regex/
  // replace/atomicWrite(超大文本上跑正则 + 构造更大写入串)。read-error 不当空配置覆盖。
  const read = await readConfigCapped(configPath);
  if (read.kind === 'too-large') {
    return { installed: false, reason: 'config-too-large' };
  }
  if (read.kind === 'read-error') {
    return { installed: false, reason: 'read-error' };
  }
  if (read.kind === 'ok') {
    text = read.text;
    fileExists = true;
  }
  // kind === 'missing' → text 保持 '',新建

  if (/\[\[hooks\.Stop\]\][\s\S]*?command\s*=\s*'''/.test(text)) {
    return { installed: false, reason: 'unrecognized-existing-stop-hook' };
  }

  // 转义感知 quoted-string:command 经 JSON.stringify 含 \" 转义,`"[^"]*"` 会在第一个
  // \" 处截断(codex P1)。用 "(?:\\.|[^"\\])*" 正确跨越转义引号。
  // 块边界:managed marker 到 command 之间不得跨入**下一个** [[hooks.Stop]](否则
  // managed 块缺/坏 command 时会一路匹配到用户自有 Stop 的 command,误替/写坏 config —
  // README I6 契约,codex P1)。兼容两种格式:marker 在 Stop 块前(生产 mergeCodexConfig)
  // 用 `(?:\[\[hooks\.Stop\]\]\s*)?` 吞掉 managed 自身的 Stop 头;marker 在块内(I6 测试)
  // 时该可选段缺省。其后 `(?!\[\[hooks\.Stop\]\])` 禁止跨入下一段。转义引号见上注。
  const managedStopPattern =
    /# continuo-managed\s*(?:\[\[hooks\.Stop\]\]\s*)?(?:(?!\[\[hooks\.Stop\]\])[\s\S])*?command\s*=\s*"(?:\\.|[^"\\])*"/;
  const managedStop = managedStopPattern.exec(text);
  if (managedStop !== null) {
    if (text.includes(hookEventsDir)) {
      return { installed: false, reason: 'already-installed' };
    }
    return replaceManagedCodexStopHook(configPath, text, hookEventsDir);
  }

  if (fileExists) {
    await copyFile(configPath, `${configPath}.continuo-bak.${Date.now()}`);
  } else {
    await mkdir(path.dirname(configPath), { recursive: true });
  }

  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl"';
  const block =
    '\n# continuo-managed\n' +
    '[[hooks.Stop]]\n' +
    '[[hooks.Stop.hooks]]\n' +
    'type = "command"\n' +
    `command = ${JSON.stringify(command)}\n`;
  // crash-safe 原子写(同 R6 理由:.codex/config.toml 不得被截断)
  await atomicWriteFile(configPath, text + block);
  return { installed: true };
}

async function replaceManagedCodexStopHook(
  configPath: string,
  text: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl"';
  // 转义感知 quoted-string(见 mergeCodexConfig 注释):command 含 JSON 转义引号 \",
  // `"[^"]*"` 只匹配到第一个 \" 即截断,替换后旧 command 尾巴残留 → 损坏 .codex/config.toml
  // (codex P1)。`"(?:\\.|[^"\\])*"` 跨越转义引号完整匹配整个 command 字符串。
  // 块边界(见 mergeCodexConfig managedStopPattern 注释):不跨入下一个 [[hooks.Stop]],
  // 兼容 marker 在块前/块内两种格式。managed 块缺/坏 command 时不匹配 → 返回 unrecognized
  // (下方 next===text),绝不误替用户自有 Stop 的 command。
  const next = text.replace(
    /(# continuo-managed\s*(?:\[\[hooks\.Stop\]\]\s*)?(?:(?!\[\[hooks\.Stop\]\])[\s\S])*?command\s*=\s*)"(?:\\.|[^"\\])*"/,
    `$1${JSON.stringify(command)}`,
  );
  if (next === text) {
    return { installed: false, reason: 'unrecognized-existing-stop-hook' };
  }
  await copyFile(configPath, `${configPath}.continuo-bak.${Date.now()}`);
  // crash-safe 原子写(同 R6 理由)
  await atomicWriteFile(configPath, next);
  return { installed: true };
}

interface AwaitStopHookToolDeps {
  readonly broker: HookFileBroker;
  readonly getSessionMeta: (
    sessionId: string,
    ctx: McpCallCtx,
  ) => TerminalSessionMetaLike | null;
}

export function createAwaitStopHookTool(
  deps: AwaitStopHookToolDeps,
): McpToolDef<AwaitStopHookInput, AwaitStopHookOutput> {
  return {
    name: MCP_TOOL_AWAIT_STOP_HOOK,
    description:
      'Block until next Stop hook fires for the given Continuo terminal session, or until timeout. ' +
      'v0.1 limitation: rejects with AWAIT_STOP_HOOK_ALREADY_PENDING if another await_stop_hook is in flight for the same (window, runner, cwd) — call sequentially for now.',
    jsonSchema: {
      type: 'object',
      properties: {
        // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX)。
        session_id: { type: 'string', minLength: 1, maxLength: SESSION_ID_MAX },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 600 },
        include_raw: { type: 'boolean' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    // 可维护性 M18:McpToolDef.inputSchema 已放宽接受 z.input≠z.output 的 schema
    //(awaitStopHookInputSchema 带 .default()),直接赋值,不再 `as unknown` 强转。
    // 边界(E203):用 session_id 加上限的 bounded 版(.default() 字段不变)。
    inputSchema: awaitStopHookBoundedSchema,
    run: async (input, ctx) => {
      // 边界(E151,E148 兄弟入口):session_id 仅 minLength,not-found/unknown-runner 错误
      // 不可原样回显超长原串(放大 JSON-RPC error/日志/内存)→ 复用共享截断 helper。
      const echoId = truncateSessionIdForEcho(input.session_id);
      const meta = deps.getSessionMeta(input.session_id, ctx);
      if (meta === null) {
        throw Object.assign(
          new Error(`terminal session not found: ${echoId}`),
          { code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND },
        );
      }

      const runner = inferRunner(meta);
      if (runner === 'unknown') {
        throw Object.assign(
          new Error(
            `unknown runner for session ${echoId}; cannot await stop hook`,
          ),
          { code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND },
        );
      }

      const startedAt = Date.now();
      const result = await deps.broker.awaitNext({
        windowId: ctx.ownerWindowId,
        runner,
        cwd: meta.cwd,
        timeoutMs: (input.timeout_sec ?? 60) * 1000,
      });

      if (!('payload' in result)) {
        return {
          status: 'timeout',
          session_id: input.session_id,
          cli_session_id: null,
          turn_id: null,
          cwd: null,
          transcript_path: null,
          last_assistant_message: null,
          elapsed_ms: result.elapsedMs,
        };
      }

      return {
        status: 'stop',
        session_id: input.session_id,
        cli_session_id: result.payload.cliSessionId,
        turn_id: result.payload.turnId,
        cwd: result.payload.cwd,
        transcript_path: result.payload.transcriptPath,
        last_assistant_message: result.payload.lastAssistantMessage,
        elapsed_ms: Date.now() - startedAt,
        ...(input.include_raw === true ? { raw: result.payload.raw } : {}),
      };
    },
  };
}
