import { spawn, type ChildProcess } from 'node:child_process';
import type { IpcMain } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { assertTrustedFrame } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
// 边界(E45,E12 shell.exec 同族):plugin-shell-stream:start 的 cmd/args/cwd/streamId 此前无长度/数量
// 上限(只 E10 修了 timeoutMs)。同仓 shell.exec(E12)已有 PATH/ARG 上限,但流式 spawn 入口漏了。
// 畸形插件可经 app.shell.execStream() 传巨量 args/超长 cwd/cmd → IPC structured clone + 主进程内存/CPU
// 放大,或触发 spawn 的 E2BIG/路径异常。与 shell.exec 对齐(E46:shared 单一来源),spawn 前 fail-closed。
import { SHELL_MAX_TIMEOUT_MS, shellCommandShapeError } from '../../shared/shell-limits';
import {
  killProcessTreesNow,
  killWithGrace,
  processTreeKillable,
  TREE_KILL_DETACHED,
} from '../lib/kill-with-grace';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { trackPluginShellProcess } from '../lib/plugin-shell-owners';
import {
  resolveSpawnCommand,
  stripInternalSecretEnv,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';
import { PLUGIN_ID_MAX_LEN } from '../../shared/permission-record-limits';
import { codedError } from '../../shared/error-message';
import { trySend } from '../lib/try-send';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = SHELL_MAX_TIMEOUT_MS;
const STREAM_ID_MAX = 256;

// 边界(E230,E227/E228/E229 数量上限族):并发 active 流式子进程数量上限。此前 START 只 active.has(streamId)
// 去重,无总量上限 —— 已授 shell 的插件可并发启动大量长跑 stream,每个占一个真实子进程 + timeoutTimer +
// IPC listener + active 条目,直到 timeout(5-30min)/abort/window cleanup 才释放,极端输入可耗尽主进程/系统
// 资源(fd / PID / 内存)。比 pending Map 族更重(对象是真实 OS 子进程)。spawn 前全局 + per-sender 双闸,
// 超限 fail-fast 抛 TOO_MANY_STREAMS(不 spawn、不入 active、不起 timer)。计数随 active Map 增删自然维护。
const MAX_ACTIVE_STREAMS_GLOBAL = 128; // 全局并发流上限(远超任何正常插件并发)
const MAX_ACTIVE_STREAMS_PER_SENDER = 32; // 单 webContents 并发流上限

// 终止进程树后仍等不到 close(后代逃出进程组仍持有管道)时,最多再等这么久即强制 finalize。
const FORCE_FINALIZE_MS = 3000;

// 在途(尚未 close)的流式子进程,跨所有 register 实例,供退出清理。子进程是 detached 进程组:
// 窗口销毁路径的 SIGTERM + 定时 SIGKILL 不被等待,IDE 退出后命令会继续运行。
const inFlight = new Set<ChildProcess>();

// 终审 P1:退出清理已开始,此后 START 一律拒绝(同 shell.service 的 exec 退出闸:插件收到 exit 即重启的
// stream 不在清理快照内,detached 进程组在 IDE 退出后存活)。
let shuttingDown = false;

/** 测试用:复位退出闸(模块级状态)。 */
export function resetShellStreamShutdownForTest(): void {
  shuttingDown = false;
}

/**
 * 退出清理(before-quit awaited):立即强杀所有在途 stream 的进程树并等待 close(有上限)。开始即置退出闸,
 * 结束前再查一遍登记表,强杀清理期间漏网登记的进程。
 */
export async function cleanupAllShellStreams(): Promise<void> {
  shuttingDown = true;
  const snapshot = new Set(inFlight);
  await killProcessTreesNow(snapshot);
  await killProcessTreesNow([...inFlight].filter((child) => !snapshot.has(child)));
}

interface ActiveStream {
  /** 终止整棵进程树(SIGTERM → 1s → SIGKILL)+ 超时未 close 强制 finalize。 */
  terminate: () => void;
  timeoutTimer: NodeJS.Timeout | null;
  senderId: number;
}

/**
 * active 表的 key:按 sender 隔离 streamId。streamId 由插件(renderer)自取,全局去重会让拿到 raw IPC 的调用方
 * 抢先用别的窗口的同名 id,使其 START 失败(拒绝服务);事件本就只发给各自 sender,id 只需 sender 内唯一。
 */
function activeKey(senderId: number, streamId: string): string {
  return `${senderId}:${streamId}`;
}

export function registerPluginShellStreamHandlers(ipcMain: IpcMain): void {
  const active = new Map<string, ActiveStream>();

  // 单个 stream 的强制清理:清 timer + 从 active 摘除 + 终止进程树
  // (子进程吞掉 SIGTERM 时不至于挂到 timeout)。killStreamsForSender 与 ABORT 共用。
  const forceKillStream = (key: string, handle: ActiveStream): void => {
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    active.delete(key);
    handle.terminate();
  };

  // 窗口/插件 webContents 销毁时,杀掉它名下所有未结束的 stream 子进程,
  // 否则插件不调 ABORT 直接 unload / 关窗会泄漏子进程直到 timeout(审计 P1)。
  const killStreamsForSender = (senderId: number): void => {
    for (const [key, handle] of active) {
      if (handle.senderId !== senderId) continue;
      forceKillStream(key, handle);
    }
  };
  const attachWcGoneHook = makeWcGoneHook(killStreamsForSender);

  // 边界(E230):某 sender 当前 active 流数。active 已封顶后 O(≤MAX_ACTIVE_STREAMS_GLOBAL)。
  const activeCountForSender = (senderId: number): number => {
    let n = 0;
    for (const handle of active.values()) {
      if (handle.senderId === senderId) n += 1;
    }
    return n;
  };

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.START,
    async (
      event,
      streamId: string,
      cmd: string,
      args: string[],
      opts?: { timeoutMs?: number; cwd?: string; pluginId?: string },
    ) => {
      // frame-trust 兜底:START 在 main 端直接 spawn,而 'shell' 权限只在 renderer 的
      // scoped-app 包装层检查。不加这道门,能触达 raw IPC 的不可信 frame(ADR-Plugin-5
      // 隔离 iframe / 未来子 frame)即可绕过权限边界触发本机命令执行。与同仓所有写/敏感
      // IPC 的 defaultIsTrustedFrame 纪律一致(复审 loop R8,同 R7 族但 spawn 面更重)。
      assertTrustedFrame(event);
      if (shuttingDown) {
        throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'shell stream rejected: app is quitting');
      }
      const key = activeKey(event.sender.id, streamId);
      if (active.has(key)) {
        throw new Error(`streamId already active: ${streamId}`);
      }

      // 边界(E230):并发 active 流数量双闸,spawn 前 fail-fast(不 spawn、不入 active、不起 timer),
      // 防已授 shell 的插件并发 spam 长跑 stream 耗尽主进程/系统资源(fd/PID/内存)。
      if (
        active.size >= MAX_ACTIVE_STREAMS_GLOBAL ||
        activeCountForSender(event.sender.id) >= MAX_ACTIVE_STREAMS_PER_SENDER
      ) {
        throw codedError(ERROR_CODES.TOO_MANY_STREAMS, 'too many active shell streams');
      }

      // 边界(E45):cmd/args/cwd/streamId 长度/数量校验,与 shell.exec(E12)对齐,spawn 前拒绝畸形
      // 巨量输入(防 IPC/内存放大 + spawn E2BIG)。raw IPC 入口手写校验(同 E10 timeoutMs 风格)。
      const badInput = (msg: string): never => {
        throw codedError(ERROR_CODES.BAD_INPUT, msg);
      };
      if (
        typeof streamId !== 'string' ||
        streamId.length === 0 ||
        streamId.length > STREAM_ID_MAX
      ) {
        badInput(`invalid streamId (empty or > ${STREAM_ID_MAX})`);
      }
      const shapeError = shellCommandShapeError(cmd, args, opts?.cwd);
      if (shapeError !== null) badInput(shapeError);
      // 终审 P1:发起插件 id(scoped app 填入),只用于本窗口内按插件终止,不作授权依据。
      const pluginId = opts?.pluginId;
      if (
        pluginId !== undefined &&
        (typeof pluginId !== 'string' || pluginId.length === 0 || pluginId.length > PLUGIN_ID_MAX_LEN)
      ) {
        badInput(`invalid pluginId (empty or > ${PLUGIN_ID_MAX_LEN})`);
      }

      // 边界(E10):raw IPC 的 opts.timeoutMs 无运行时 schema。插件传 NaN/负数/0/Infinity/非数字时,
      // 旧 `Math.min(x, MAX)` 会得到 NaN 或负值,`setTimeout(.., timeoutMs)` 退化为**立即触发** →
      // 合法的流式 shell 命令一启动就被 SIGTERM,插件看到随机/立即退出。仅当有限正数才采用并 clamp
      // 到 MAX,否则回默认值(fail-safe,不拒绝合法启动)。
      const rawTimeout = opts?.timeoutMs;
      const timeoutMs =
        typeof rawTimeout === 'number' &&
        Number.isFinite(rawTimeout) &&
        rawTimeout > 0
          ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
          : DEFAULT_TIMEOUT_MS;
      // 不用 shell:true(同 shell.service:破坏参数原子性 + 注入面)。
      // Windows .cmd/.bat 的正确启动方式需 PATHEXT 检测 + cmd.exe 包装 + quoting → DEFER。
      // 安全:git 命令行作用域 core.fsmonitor=false 兜底;Windows 裸命令名只在 PATH 绝对目录中解析、
      // 不查 cwd,解析不到抛错不 spawn(同 shell.service,见 lib/child-spawn-hardening)。
      // 剥离宿主内部机密(CONTINUO_MCP_TOKEN),见 INTERNAL_SECRET_ENV_KEYS。
      const env = withGitHardeningEnv(stripInternalSecretEnv(process.env));
      const child = spawn(resolveSpawnCommand(cmd, env), args, {
        cwd: opts?.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 新进程组(POSIX),终止时整组发信号,后台后代不成孤儿(见 processTreeKillable)。
        detached: TREE_KILL_DETACHED,
      });
      inFlight.add(child);
      child.once('close', () => inFlight.delete(child));
      child.once('error', () => inFlight.delete(child));
      const senderWc = event.sender;
      const senderId = senderWc.id;
      trackPluginShellProcess(child, senderId, pluginId);
      // renderer reload / webContents 销毁时杀掉该 sender 名下所有在途 stream(reload 不会触发 iterator
      // 的 return() → 不发 ABORT,子进程会泄漏到 timeout)。时机与去重见 lib/wc-gone-hook。
      attachWcGoneHook(senderWc);
      let settled = false;

      const send = (
        kind: 'stdout' | 'stderr' | 'exit',
        payload: unknown,
      ): void => {
        // race(R72,R71 同构):send 在 stdout/stderr data 回调与 child.on('error') 的「send('stderr') 再
        // finalize(-1)」序列里被调,若抛则 finalize 不执行 → active 条目 + timeoutTimer 泄漏。trySend 不冒泡;
        // sender 已销毁时静默丢弃本次事件,stream 由 did-start-navigation / finalize 清理。
        trySend(senderWc, PLUGIN_SHELL_STREAM_CHANNELS.EVENT, { streamId, kind, payload });
      };

      const finalize = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        const handle = active.get(key);
        if (handle?.timeoutTimer) clearTimeout(handle.timeoutTimer);
        active.delete(key);
        send('exit', { exitCode, signal });
      };

      child.stdout.on('data', (chunk: Buffer) => send('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => send('stderr', chunk));
      child.on('close', (code, signal) => finalize(code, signal));
      child.on('error', (err) => {
        send(
          'stderr',
          Buffer.from(
            `[plugin-shell-stream] spawn error: ${err.message}\n`,
            'utf-8',
          ),
        );
        finalize(-1, null);
      });

      // 终止整棵进程树;若仍迟迟不 close(后代逃出进程组仍持管道),销毁 stdio 并强制 finalize,
      // 不让 done / active 槽位无限挂住。
      const terminate = (): void => {
        if (settled) return;
        killWithGrace(processTreeKillable(child));
        const forceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finalize(child.exitCode, child.signalCode);
        }, FORCE_FINALIZE_MS);
        forceTimer.unref?.();
      };

      const timeoutTimer = setTimeout(terminate, timeoutMs);
      const maybeUnref = timeoutTimer as { unref?: () => void };
      if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
      active.set(key, { terminate, timeoutTimer, senderId });
    },
  );

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    async (event, streamId: string) => {
      // 同 START 的 frame-trust 兜底(R8)。
      assertTrustedFrame(event);
      const key = activeKey(event.sender.id, streamId);
      const handle = active.get(key);
      // 归属:active 的 key 含 sender id,别的 sender 按同一 streamId 查不到这条(无法 abort 别人的 stream)。
      if (!handle) return;
      // 审计 P2-A:旧实现只发 SIGTERM,不清 active 表也不升级 SIGKILL;子进程
      // 吞掉 SIGTERM 时会挂到 timeout(最长 30min)且 active 条目+timer 驻留。
      forceKillStream(key, handle);
    },
  );
}

// 边界(E230)测试用:并发流上限常量。
export const MAX_ACTIVE_STREAMS_GLOBAL_FOR_TEST = MAX_ACTIVE_STREAMS_GLOBAL;
export const MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST = MAX_ACTIVE_STREAMS_PER_SENDER;
