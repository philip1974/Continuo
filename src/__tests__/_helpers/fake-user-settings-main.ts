// 测试用:内存版「主进程设置存储」(语义同 electron/main/services/user-settings.service:串行读-改-写、无变化不提交、
// 版本单调、提交后先广播再回复、文件原本不存在时才接受迁入),以及每个「窗口」一份的 renderer host(coApi.userSettings)。
// 真实 main 服务 + 真实磁盘的端到端见 src/__tests__/user-settings-main-store/renderer-main-roundtrip.spec.ts。
import type { ContinuoApi } from '../../../electron/preload';
import type {
  UserSettingsChanged,
  UserSettingsRecord,
  UserSettingsScope,
  UserSettingsScopeState,
} from '../../../electron/shared/user-settings';
import type { IpcResult } from '../../../electron/shared/ipc-result';

type Host = ContinuoApi['userSettings'];

interface ScopeInit {
  readonly record?: UserSettingsRecord;
  readonly needsImport?: boolean;
  readonly persistBlocked?: boolean;
}

export interface FakeUserSettingsMain {
  /** 当前「已落盘」的记录。 */
  record(scope: UserSettingsScope): UserSettingsRecord;
  /** 一个新窗口的 host(各自订阅广播)。 */
  host(): Host;
  /** 把一个新 host 装到 window.api.userSettings(之后创建的 store 用它)。 */
  install(): Host;
  /** 模拟别的窗口经 main 修改(main 提交并广播)。 */
  externalUpdate(scope: UserSettingsScope, set: UserSettingsRecord, remove?: readonly string[]): void;
  /** 以新版本重发当前记录(内容不变的广播)。 */
  rebroadcast(scope: UserSettingsScope): void;
  /** 下一次 update 失败(返回 {ok:false, code})。 */
  failNextUpdate(code: string): void;
  /** 收到的调用(按到达顺序)。 */
  readonly calls: Array<{ kind: 'update' | 'import'; scope: UserSettingsScope; set?: UserSettingsRecord; remove?: readonly string[]; record?: UserSettingsRecord }>;
}

/** 等所有已排队的 IPC 回复(fake 的回复在微任务里)。 */
export async function flushUserSettings(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

export function createFakeUserSettingsMain(
  init: Partial<Record<UserSettingsScope, ScopeInit>> = {},
): FakeUserSettingsMain {
  let versionCounter = 0;
  const mk = (s: ScopeInit | undefined) => ({
    record: { ...(s?.record ?? {}) } as UserSettingsRecord,
    version: ++versionCounter,
    missing: s?.needsImport ?? false,
    blocked: s?.persistBlocked ?? false,
  });
  const states = { settings: mk(init.settings), keybindings: mk(init.keybindings) };
  const listeners = new Set<(p: UserSettingsChanged) => void>();
  const calls: FakeUserSettingsMain['calls'] = [];
  let failCode: string | null = null;

  const pub = (scope: UserSettingsScope): UserSettingsScopeState => ({
    version: states[scope].version,
    record: states[scope].record,
  });
  const commit = (scope: UserSettingsScope, next: UserSettingsRecord): void => {
    const st = states[scope];
    st.record = next;
    st.missing = false;
    st.version = ++versionCounter;
    const payload: UserSettingsChanged = { scope, ...pub(scope) };
    for (const l of [...listeners]) l(payload);
  };
  const apply = (scope: UserSettingsScope, set: UserSettingsRecord, remove: readonly string[]): void => {
    const cur = states[scope].record;
    let next: UserSettingsRecord | null = null;
    for (const k of remove) {
      if (!Object.hasOwn(cur, k)) continue;
      next ??= { ...cur };
      delete next[k];
    }
    for (const k of Object.keys(set)) {
      if (Object.is((next ?? cur)[k], set[k])) continue;
      next ??= { ...cur };
      Object.defineProperty(next, k, { value: set[k], enumerable: true, writable: true, configurable: true });
    }
    if (next) commit(scope, next);
  };
  const reply = <T>(fn: () => T): Promise<IpcResult<T>> =>
    Promise.resolve().then(() => ({ ok: true as const, data: fn() }));

  const host = (): Host => ({
    snapshot: () => ({
      settings: { ...pub('settings'), needsImport: states.settings.missing, persistBlocked: states.settings.blocked },
      keybindings: { ...pub('keybindings'), needsImport: states.keybindings.missing, persistBlocked: states.keybindings.blocked },
    }),
    update: (scope, set, remove) => {
      calls.push({ kind: 'update', scope, set: { ...set }, remove: [...remove] });
      if (failCode !== null) {
        const code = failCode;
        failCode = null;
        return Promise.resolve({ ok: false, code, message: code });
      }
      return reply(() => {
        apply(scope, set, remove);
        return pub(scope);
      });
    },
    importLegacy: (scope, record) => {
      calls.push({ kind: 'import', scope, record: { ...record } });
      return reply(() => {
        if (states[scope].missing && Object.keys(record).length > 0) commit(scope, { ...record });
        return pub(scope);
      });
    },
    onChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });

  return {
    record: (scope) => states[scope].record,
    host,
    install: () => {
      const h = host();
      const w = globalThis as unknown as { window: { api?: Record<string, unknown> } };
      w.window.api = { ...(w.window.api ?? {}), userSettings: h };
      return h;
    },
    externalUpdate: (scope, set, remove = []) => apply(scope, set, remove),
    rebroadcast: (scope) => commit(scope, states[scope].record),
    failNextUpdate: (code) => {
      failCode = code;
    },
    calls,
  };
}

/** 卸掉 window.api.userSettings(恢复「无 main」)。 */
export function uninstallUserSettingsHost(): void {
  const w = globalThis as unknown as { window: { api?: Record<string, unknown> } };
  if (w.window.api) delete w.window.api['userSettings'];
}
