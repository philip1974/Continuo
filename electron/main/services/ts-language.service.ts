// TS / JS 语言服务的 main 侧管理(VSCode typescript-language-features 的 TypeScriptServiceClient 极简对应)。
// - 每个 renderer(webContents = 一个主窗,其 popout 子窗共用)一个语言服务进程,根 = 该窗口的工作区根(VSCode 每个窗口一个
//   tsserver)。懒启动:第一个请求(打开 TS / JS 文件时的预热,或转到定义)才 spawn。窗口关闭 / 重载 / renderer 崩溃 → 结束进程;
//   工作区根变了 → 结束旧进程,下个请求按新根启动。空闲不结束(VSCode 同)。
// - 未保存文档(overlay)由 main 记一份权威副本:进程(重)启动时整份重放,之后只发差异 —— 崩溃重启后跳转仍按未保存内容。
// - 请求槽:同一槽(悬停 / 命令)的新请求取代旧请求(旧的以 cancelled 结束,排队中的不再计算);每个请求有超时。
// - 崩溃:在途请求以 unavailable(crashed) 结束,推送 crashed 事件(renderer 提示);下个请求自动重启。5 分钟内崩溃 5 次 → 不再
//   重启(fatal),直到窗口重载或换工作区(VSCode:短时间内多次崩溃后停止重启并提示)。
// 进程工厂注入(生产为 utilityProcess.fork,见 ipc/ts-language.ipc;单测注入假进程)。
// BDD: src/__tests__/editor-go-to-definition/

import { trySend, type SendTarget } from '../lib/try-send';
import { isSameOrInsidePath } from '../lib/path-inside';
import {
  isTsLanguagePath,
  TS_LANGUAGE_CHANNELS,
  type TsLanguageEvent,
  type TsRequestInput,
  type TsRequestReply,
  type TsRequestSlot,
} from '../../shared/ts-language';
import type { TsServerRequest, TsServerResponse } from '../ts-language/ts-server-protocol';

export interface TsServerChild {
  postMessage(msg: TsServerRequest): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export type SpawnTsServer = () => TsServerChild;

export interface TsLanguageTarget extends SendTarget {
  readonly id: number;
}

export const TS_REQUEST_TIMEOUT_MS = 30_000;
export const TS_CRASH_LIMIT = 5;
export const TS_CRASH_WINDOW_MS = 5 * 60_000;

export interface TsLanguageService {
  request(target: TsLanguageTarget, root: string | null, input: TsRequestInput): Promise<TsRequestReply>;
  dispose(targetId: number): void;
}

interface Pending {
  readonly resolve: (r: TsRequestReply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly slot: TsRequestSlot;
}

interface RunningChild {
  readonly proc: TsServerChild;
  /** 进程里已有的未保存文档版本。 */
  readonly docs: Map<string, number>;
}

interface Session {
  readonly target: TsLanguageTarget;
  readonly root: string;
  readonly clientId: string;
  overlay: Map<string, { readonly version: number; readonly text: string }>;
  child: RunningChild | null;
  readonly crashes: number[];
  fatal: boolean;
  readonly pending: Map<number, Pending>;
  readonly slots: Map<TsRequestSlot, number>;
}

const CANCELLED: TsRequestReply = { status: 'cancelled' };
const unavailable = (reason: Extract<TsRequestReply, { status: 'unavailable' }>['reason']): TsRequestReply => ({
  status: 'unavailable',
  reason,
});

export function createTsLanguageService(deps: {
  readonly spawn: SpawnTsServer;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): TsLanguageService {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? TS_REQUEST_TIMEOUT_MS;
  const sessions = new Map<number, Session>();
  let nextId = 1;

  const settle = (s: Session, id: number, reply: TsRequestReply): void => {
    const p = s.pending.get(id);
    if (!p) return;
    s.pending.delete(id);
    clearTimeout(p.timer);
    if (s.slots.get(p.slot) === id) s.slots.delete(p.slot);
    p.resolve(reply);
  };

  const settleAll = (s: Session, reply: TsRequestReply): void => {
    for (const id of [...s.pending.keys()]) settle(s, id, reply);
  };

  const stopChild = (s: Session): void => {
    const c = s.child;
    s.child = null;
    if (c) c.proc.kill();
  };

  const disposeSession = (s: Session): void => {
    if (sessions.get(s.target.id) === s) sessions.delete(s.target.id);
    settleAll(s, CANCELLED);
    stopChild(s);
  };

  const onCrash = (s: Session): void => {
    settleAll(s, unavailable('crashed'));
    const t = now();
    s.crashes.push(t);
    while (s.crashes.length > 0 && t - s.crashes[0]! > TS_CRASH_WINDOW_MS) s.crashes.shift();
    if (s.crashes.length >= TS_CRASH_LIMIT) s.fatal = true;
    const event: TsLanguageEvent = { kind: 'crashed', fatal: s.fatal };
    trySend(s.target, TS_LANGUAGE_CHANNELS.EVENT, event);
  };

  const startChild = (s: Session): RunningChild => {
    const proc = deps.spawn();
    const child: RunningChild = { proc, docs: new Map() };
    s.child = child;
    proc.onMessage((raw) => {
      if (s.child !== child || typeof raw !== 'object' || raw === null) return;
      const msg = raw as TsServerResponse;
      if (typeof msg.id !== 'number') return;
      if (msg.type === 'result') settle(s, msg.id, { status: 'ok', origin: msg.origin, definitions: msg.definitions });
      else if (msg.type === 'cancelled') settle(s, msg.id, CANCELLED);
      else if (msg.type === 'error') settle(s, msg.id, unavailable('error'));
    });
    proc.onExit(() => {
      if (s.child !== child) return; // 主动结束(关窗 / 换根 / 重载)
      s.child = null;
      onCrash(s);
    });
    proc.postMessage({ type: 'init', root: s.root });
    return child;
  };

  /** 把 overlay 与进程里已有的版本对齐(只发差异)。 */
  const syncChild = (s: Session, child: RunningChild): void => {
    const changes: { path: string; text: string | null }[] = [];
    for (const [p, doc] of s.overlay) {
      if (child.docs.get(p) !== doc.version) {
        changes.push({ path: p, text: doc.text });
        child.docs.set(p, doc.version);
      }
    }
    for (const p of [...child.docs.keys()]) {
      if (!s.overlay.has(p)) {
        changes.push({ path: p, text: null });
        child.docs.delete(p);
      }
    }
    if (changes.length > 0) child.proc.postMessage({ type: 'sync', changes });
  };

  const sessionFor = (target: TsLanguageTarget, root: string, clientId: string): Session => {
    const cur = sessions.get(target.id);
    if (cur && cur.root === root && cur.clientId === clientId) return cur;
    if (cur) disposeSession(cur);
    const s: Session = {
      target,
      root,
      clientId,
      overlay: new Map(),
      child: null,
      crashes: [],
      fatal: false,
      pending: new Map(),
      slots: new Map(),
    };
    sessions.set(target.id, s);
    return s;
  };

  return {
    async request(target, root, input) {
      if (root === null) return unavailable('no-root');
      const { op } = input;
      if (!isTsLanguagePath(op.path) || !isSameOrInsidePath(root, op.path)) return unavailable('outside-root');
      const s = sessionFor(target, root, input.clientId);

      // 未保存文档:请求里列出的就是当前全部;没带全文且 main 没有该版本 → 让 renderer 补全文
      const overlay = new Map<string, { version: number; text: string }>();
      const missing: string[] = [];
      for (const doc of input.docs) {
        if (!isTsLanguagePath(doc.path) || !isSameOrInsidePath(root, doc.path)) continue;
        if (doc.text !== undefined) overlay.set(doc.path, { version: doc.version, text: doc.text });
        else {
          const known = s.overlay.get(doc.path);
          if (known?.version === doc.version) overlay.set(doc.path, known);
          else missing.push(doc.path);
        }
      }
      if (missing.length > 0) return { status: 'resync', paths: missing };
      s.overlay = overlay;

      if (s.fatal) return unavailable('fatal');
      const child = s.child ?? startChild(s);
      syncChild(s, child);

      if (op.kind === 'warmup') {
        child.proc.postMessage({ type: 'warmup', path: op.path });
        return { status: 'ok', origin: null, definitions: [] };
      }

      const prev = s.slots.get(op.slot);
      if (prev !== undefined) {
        settle(s, prev, CANCELLED);
        child.proc.postMessage({ type: 'cancel', id: prev });
      }
      const id = nextId++;
      return new Promise<TsRequestReply>((resolve) => {
        const timer = setTimeout(() => {
          settle(s, id, unavailable('timeout'));
          s.child?.proc.postMessage({ type: 'cancel', id });
        }, timeoutMs);
        s.pending.set(id, { resolve, timer, slot: op.slot });
        s.slots.set(op.slot, id);
        child.proc.postMessage({ type: 'definition', id, path: op.path, line: op.line, column: op.column });
      });
    },
    dispose(targetId) {
      const s = sessions.get(targetId);
      if (s) disposeSession(s);
    },
  };
}
