import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { IpcMain, WebContents } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { defaultIsTrustedFrame } from '../safe-handle';
import { IPC_ERR } from '../../shared/ipc-result';
import { ERROR_CODES } from '../../shared/error-codes';
// 边界(E45,E12 shell.exec 同族):plugin-shell-stream:start 的 cmd/args/cwd/streamId 此前无长度/数量
// 上限(只 E10 修了 timeoutMs)。同仓 shell.exec(E12)已有 PATH/ARG 上限,但流式 spawn 入口漏了。
// 畸形插件可经 app.shell.execStream() 传巨量 args/超长 cwd/cmd → IPC structured clone + 主进程内存/CPU
// 放大,或触发 spawn 的 E2BIG/路径异常。与 shell.exec 对齐(E46:shared 单一来源),spawn 前 fail-closed。
import {
  SHELL_PATH_MAX as PATH_MAX,
  SHELL_ARG_MAX_LEN as ARG_MAX_LEN,
  SHELL_ARGS_MAX_COUNT as ARGS_MAX_COUNT,
} from '../../shared/shell-limits';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const STREAM_ID_MAX = 256;

// 边界(E230,E227/E228/E229 数量上限族):并发 active 流式子进程数量上限。此前 START 只 active.has(streamId)
// 去重,无总量上限 —— 已授 shell 的插件可并发启动大量长跑 stream,每个占一个真实子进程 + timeoutTimer +
// IPC listener + active 条目,直到 timeout(5-30min)/abort/window cleanup 才释放,极端输入可耗尽主进程/系统
// 资源(fd / PID / 内存)。比 pending Map 族更重(对象是真实 OS 子进程)。spawn 前全局 + per-sender 双闸,
// 超限 fail-fast 抛 TOO_MANY_STREAMS(不 spawn、不入 active、不起 timer)。计数随 active Map 增删自然维护。
const MAX_ACTIVE_STREAMS_GLOBAL = 128; // 全局并发流上限(远超任何正常插件并发)
const MAX_ACTIVE_STREAMS_PER_SENDER = 32; // 单 webContents 并发流上限

interface ActiveStream {
  child: ChildProcessByStdio<null, Readable, Readable>;
  timeoutTimer: NodeJS.Timeout | null;
  senderId: number;
}

export function registerPluginShellStreamHandlers(ipcMain: IpcMain): void {
  const active = new Map<string, ActiveStream>();
  // 已挂生命周期钩子的 webContents(WeakSet 按对象去重,跨 reload 持久且随 wc 销毁
  // 自动回收),避免同一 webContents 多次 START 累积监听器。镜像 plugin-mcp.ipc 的
  // wcAttached —— 用对象身份而非 numeric id,这样 did-start-navigation 的持久监听器
  // 在反复 reload 时只挂一次。
  const wcAttached = new WeakSet<WebContents>();

  // 单个 stream 的强制清理:清 timer + 从 active 摘除 + SIGTERM,1s 后 SIGKILL 兜底
  // (子进程吞掉 SIGTERM 时不至于挂到 timeout)。killStreamsForSender 与 ABORT 共用。
  const forceKillStream = (streamId: string, handle: ActiveStream): void => {
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    active.delete(streamId);
    const child = handle.child;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 1000);
    const maybeUnref = killTimer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
  };

  // 窗口/插件 webContents 销毁时,杀掉它名下所有未结束的 stream 子进程,
  // 否则插件不调 ABORT 直接 unload / 关窗会泄漏子进程直到 timeout(审计 P1)。
  const killStreamsForSender = (senderId: number): void => {
    for (const [streamId, handle] of active) {
      if (handle.senderId !== senderId) continue;
      forceKillStream(streamId, handle);
    }
  };

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
      opts?: { timeoutMs?: number; cwd?: string },
    ) => {
      // frame-trust 兜底:START 在 main 端直接 spawn,而 'shell' 权限只在 renderer 的
      // scoped-app 包装层检查。不加这道门,能触达 raw IPC 的不可信 frame(ADR-Plugin-5
      // 隔离 iframe / 未来子 frame)即可绕过权限边界触发本机命令执行。与同仓所有写/敏感
      // IPC 的 defaultIsTrustedFrame 纪律一致(codex 复审 loop R8,同 R7 族但 spawn 面更重)。
      if (!defaultIsTrustedFrame(event.senderFrame)) {
        throw Object.assign(new Error('sender frame is not trusted'), {
          code: IPC_ERR.DENIED,
        });
      }
      if (active.has(streamId)) {
        throw new Error(`streamId already active: ${streamId}`);
      }

      // 边界(E230):并发 active 流数量双闸,spawn 前 fail-fast(不 spawn、不入 active、不起 timer),
      // 防已授 shell 的插件并发 spam 长跑 stream 耗尽主进程/系统资源(fd/PID/内存)。
      if (
        active.size >= MAX_ACTIVE_STREAMS_GLOBAL ||
        activeCountForSender(event.sender.id) >= MAX_ACTIVE_STREAMS_PER_SENDER
      ) {
        throw Object.assign(
          new Error('too many active shell streams'),
          { code: ERROR_CODES.TOO_MANY_STREAMS },
        );
      }

      // 边界(E45):cmd/args/cwd/streamId 长度/数量校验,与 shell.exec(E12)对齐,spawn 前拒绝畸形
      // 巨量输入(防 IPC/内存放大 + spawn E2BIG)。raw IPC 入口手写校验(同 E10 timeoutMs 风格)。
      const badInput = (msg: string): never => {
        throw Object.assign(new Error(msg), { code: ERROR_CODES.BAD_INPUT });
      };
      if (
        typeof streamId !== 'string' ||
        streamId.length === 0 ||
        streamId.length > STREAM_ID_MAX
      ) {
        badInput(`invalid streamId (empty or > ${STREAM_ID_MAX})`);
      }
      if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > PATH_MAX) {
        badInput(`invalid cmd (empty or > ${PATH_MAX})`);
      }
      if (!Array.isArray(args) || args.length > ARGS_MAX_COUNT) {
        badInput(`invalid args (not array or count > ${ARGS_MAX_COUNT})`);
      }
      if (
        !args.every((a) => typeof a === 'string' && a.length <= ARG_MAX_LEN)
      ) {
        badInput(`invalid arg entry (non-string or > ${ARG_MAX_LEN})`);
      }
      if (
        opts?.cwd !== undefined &&
        (typeof opts.cwd !== 'string' || opts.cwd.length > PATH_MAX)
      ) {
        badInput(`invalid cwd (> ${PATH_MAX})`);
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
      // 不用 shell:true(同 shell.service:破坏参数原子性 + 注入面,codex diff 复查)。
      // Windows .cmd/.bat 的正确启动方式需 PATHEXT 检测 + cmd.exe 包装 + quoting → DEFER。
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const senderWc = event.sender;
      const senderId = senderWc.id;
      if (typeof senderWc.once === 'function' && !wcAttached.has(senderWc)) {
        wcAttached.add(senderWc);
        senderWc.once('destroyed', () => killStreamsForSender(senderId));
        // 审计(第八 session R2):renderer reload(Ctrl+R / HMR full reload /
        // webContents.reload())时 webContents 不销毁、wcId 不变 → 'destroyed' 不触发;
        // 且 renderer 侧 for-await iterator 的 return() 不会在 reload 时跑(reload 直接
        // 撕掉 JS,不触发 generator finalize)→ 不发 ABORT → 子进程 + active 条目 +
        // timeoutTimer 泄漏到 timeout(5-30min),反复 reload 每次累积一个孤儿子进程。
        // 镜像 plugin-mcp.ipc attachWcDestroyHookOnce 的 did-start-navigation hook:在新
        // 文档加载前杀掉该 sender 名下所有在途 stream。仅 main frame 真实(非同文档)导航
        // 才清,避免 hash/pushState 误清;同 wc 持久监听覆盖反复 reload。
        if (typeof senderWc.on === 'function') {
          senderWc.on('did-start-navigation', (details) => {
            if (details.isMainFrame && !details.isSameDocument) {
              killStreamsForSender(senderId);
            }
          });
        }
      }
      let settled = false;

      const send = (
        kind: 'stdout' | 'stderr' | 'exit',
        payload: unknown,
      ): void => {
        if (senderWc.isDestroyed()) return;
        // race(R72,R71 同构):isDestroyed() 检查后、send 前 webContents 可能销毁(renderer
        // reload/关窗),send 抛 "Object has been destroyed"。send 在 stdout/stderr data 回调
        // (裸抛成主进程未捕获异常)和 child.on('error') 的「send('stderr') 再 finalize(-1)」
        // 序列里被调:若 send 抛,后面的 finalize **不执行** → active 条目 + timeoutTimer 泄漏
        // (spawn error 的子进程不发 'close',finalize 永不被触发,插件侧 stream 也等不到 exit)。
        // send 包 try/catch 不冒泡,保证 child error/close 路径的 finalize 始终执行清 active/timer。
        try {
          senderWc.send(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, {
            streamId,
            kind,
            payload,
          });
        } catch {
          // sender 已销毁:静默丢弃本次事件;stream 由 did-start-navigation/finalize 清理。
        }
      };

      const finalize = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        const handle = active.get(streamId);
        if (handle?.timeoutTimer) clearTimeout(handle.timeoutTimer);
        active.delete(streamId);
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

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        // SIGKILL 升级 grace timer 必须 unref:否则超时触发后,即便子进程已死,
        // 这个内层 timer 仍会把 event loop 多撑 1s(关窗/退出时延迟退出)。与
        // forceKillStream 的 killTimer 同款防御 —— 此前漏 unref(unref 模式未传播)。
        const killGraceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
        const maybeUnrefKill = killGraceTimer as { unref?: () => void };
        if (typeof maybeUnrefKill.unref === 'function') maybeUnrefKill.unref();
      }, timeoutMs);
      const maybeUnref = timeoutTimer as { unref?: () => void };
      if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
      active.set(streamId, { child, timeoutTimer, senderId });
    },
  );

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    async (event, streamId: string) => {
      // 同 START 的 frame-trust 兜底(R8)。
      if (!defaultIsTrustedFrame(event.senderFrame)) {
        throw Object.assign(new Error('sender frame is not trusted'), {
          code: IPC_ERR.DENIED,
        });
      }
      const handle = active.get(streamId);
      if (!handle) return;
      // 归属校验:只有发起该 stream 的 sender 能 abort 它,避免跨 sender 按 streamId
      // 终止别人的 stream(codex 复审 loop R8 次要项)。
      if (handle.senderId !== event.sender.id) return;
      // 审计 P2-A:旧实现只发 SIGTERM,不清 active 表也不升级 SIGKILL;子进程
      // 吞掉 SIGTERM 时会挂到 timeout(最长 30min)且 active 条目+timer 驻留。
      forceKillStream(streamId, handle);
    },
  );
}

export const DEFAULT_TIMEOUT_MS_FOR_TEST = DEFAULT_TIMEOUT_MS;
export const MAX_TIMEOUT_MS_FOR_TEST = MAX_TIMEOUT_MS;
// 边界(E230)测试用:并发流上限常量。
export const MAX_ACTIVE_STREAMS_GLOBAL_FOR_TEST = MAX_ACTIVE_STREAMS_GLOBAL;
export const MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST = MAX_ACTIVE_STREAMS_PER_SENDER;
