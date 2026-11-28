// 设置值 / 快捷键覆盖(「string→V 记录」型 zustand store)的读写与跨窗同步:权威存储在主进程文件
//(electron/main/services/user-settings.service,对齐 VSCode 每次修改立即写 settings.json / keybindings.json)。
// 此前存在 renderer localStorage:Chromium 延迟数秒才把它刷到磁盘,改完后主进程崩溃 / 强杀会丢掉刚改的设置。
//
// - 首帧:snapshot() 是同步 IPC,store 创建时(及入口模块定首帧主题时)即拿到当前值,不闪默认值。
// - 写:先乐观更新本窗内存(界面立即反映),再把增量发给 main;main 串行读-改-写并原子写盘后广播新状态。
//   多窗口并发改不同 key 不再互相覆盖(此前 localStorage 读-改-写的跨窗 lost update,race R113)。
// - 收敛:main 每次提交带单调版本;本窗有未回复的写时只记下最新权威状态,写全部回复后整体收敛到它 —— 写失败(超限 /
//   写盘失败)自然回滚到权威值,乱序到达的旧广播也不会把新值改回去。
// - 一次性迁移:main 文件原本不存在(needsImport)时,把旧 localStorage 记录作为初值并发给 main 迁入;之后以文件为准。
//   旧 localStorage 记录保留不删:降级回旧版本时它仍能读到(只是停在迁移那一刻的值),而新版本只认文件、不会再读它。
// - 无 main(单测 / 无 preload):按旧 localStorage 记录只读初始化,修改只留在内存。
// BDD: src/__tests__/user-settings-main-store/
import { ownValue, setOwnValue } from '../../../electron/shared/own-value';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import type {
  UserSettingsRecord,
  UserSettingsScope,
  UserSettingsScopeSnapshot,
  UserSettingsScopeState,
  UserSettingsValue,
} from '../../../electron/shared/user-settings';
import type { IpcResult } from '../../../electron/shared/ipc-result';
import { constrainRecord, readRecord, recordsShallowEqual, type ReadRecordOptions } from './local-storage-record';
import { userSettingsHost } from './user-settings-initial';

export interface UserSettingsRecordOps<V> {
  /** 启动时的记录(已按 readOpts 规整、已迁移旧 id),store 的初值。 */
  readonly initial: Record<string, V>;
  /** 设单 key(值等于当前内存时 no-op)。 */
  setEntry: (k: string, v: V) => void;
  /** 删单 key(内存里没有时 no-op)。 */
  removeEntry: (k: string) => void;
}

/** 两个记录的差异(next 相对 prev:要设的与要删的)。 */
function diffRecords<V>(prev: Record<string, V>, next: Record<string, V>): { set: Record<string, V>; remove: string[] } {
  const set: Record<string, V> = {};
  const remove: string[] = [];
  for (const k in next) {
    if (Object.prototype.hasOwnProperty.call(next, k) && !Object.is(ownValue(prev, k), next[k])) setOwnValue(set, k, next[k]!);
  }
  for (const k in prev) {
    if (Object.prototype.hasOwnProperty.call(prev, k) && !Object.hasOwn(next, k)) remove.push(k);
  }
  return { set, remove };
}

export function createUserSettingsRecordOps<V extends UserSettingsValue>(opts: {
  readonly scope: UserSettingsScope;
  /** 旧版 localStorage 键(一次性迁移的来源)。 */
  readonly legacyKey: string;
  readonly readOpts: ReadRecordOptions<V>;
  readonly getRecord: () => Record<string, V>;
  readonly setRecord: (next: Record<string, V>) => void;
  /** 超条目 / 字节上限被 main 拒写时 console.warn 的文案(内存回滚到上次有效状态)。 */
  readonly tooLargeWarning: string;
  /** 写盘失败时的通知文案。 */
  readonly saveFailedMessage: () => string;
  /** 读盘失败(本次运行的修改不会保存)时,第一次修改后的通知文案。 */
  readonly notSavedMessage: () => string;
  /** 记录交给 store 前的迁移(如设置 id 改名);无需迁移时须返回原对象。迁移改动了已存记录时立即把差异写回 main。 */
  readonly migrate?: (record: Record<string, V>) => Record<string, V>;
  /** 通知(注入以免本模块依赖通知 / i18n;error 用于写盘失败,warn 用于本次不保存)。 */
  readonly notify: { error: (message: string, key: string) => void; warn: (message: string, key: string) => void };
}): UserSettingsRecordOps<V> {
  const { scope, legacyKey, readOpts, getRecord, setRecord, migrate } = opts;
  const host = userSettingsHost();
  const snap: UserSettingsScopeSnapshot | null = (() => {
    try {
      return host?.snapshot()?.[scope] ?? null;
    } catch {
      return null;
    }
  })();
  const constrain = (raw: unknown): Record<string, V> => constrainRecord<V>(raw, readOpts) ?? {};
  const toStore = (raw: unknown): Record<string, V> => {
    const r = constrain(raw);
    return migrate ? migrate(r) : r;
  };

  // 已知的最新权威状态(main 的快照 / 回复 / 广播里版本最大的那个)。
  let authVersion = snap?.version ?? 0;
  let authRecord: unknown = snap?.record ?? {};
  let pending = 0;
  let notSavedShown = false;

  const accept = (state: UserSettingsScopeState): void => {
    if (state.version <= authVersion) return;
    authVersion = state.version;
    authRecord = state.record;
  };
  const converge = (): void => {
    if (pending > 0) return;
    const latest = toStore(authRecord);
    if (!recordsShallowEqual(getRecord(), latest)) setRecord(latest);
  };
  const failed = (r: { code?: string; message?: string } | undefined, err?: unknown): void => {
    if (r?.code === ERROR_CODES.PAYLOAD_TOO_LARGE) {
      console.warn(opts.tooLargeWarning);
      return;
    }
    console.warn(`[user-settings] ${scope}: save failed`, r?.message ?? err);
    opts.notify.error(opts.saveFailedMessage(), `user-settings:${scope}:save-failed`);
  };
  const send = (call: () => Promise<IpcResult<UserSettingsScopeState>>): void => {
    if (!host) return; // 无 main:只改内存
    pending += 1;
    let p: Promise<IpcResult<UserSettingsScopeState>>;
    try {
      p = call();
    } catch (err) {
      p = Promise.reject(err);
    }
    void p
      .then(
        (r) => {
          if (r.ok) {
            accept(r.data);
            if (snap?.persistBlocked && !notSavedShown) {
              notSavedShown = true;
              opts.notify.warn(opts.notSavedMessage(), `user-settings:${scope}:not-saved`);
            }
          } else {
            failed(r);
          }
        },
        (err: unknown) => failed(undefined, err),
      )
      .finally(() => {
        pending -= 1;
        converge();
      });
  };

  // 初值:已迁移 → main 快照;需要迁移 / 无 main → 旧 localStorage 记录(需要迁移时同时发给 main 迁入)。
  let storedRaw: Record<string, V>;
  if (snap && !snap.needsImport) {
    storedRaw = constrain(snap.record);
  } else {
    storedRaw = readRecord<V>(legacyKey, readOpts);
    if (snap && Object.keys(storedRaw).length > 0) {
      const legacy = storedRaw;
      send(() => host!.importLegacy(scope, legacy));
    }
  }
  const initial = migrate ? migrate(storedRaw) : storedRaw;
  if (initial !== storedRaw) {
    const { set, remove } = diffRecords(storedRaw, initial);
    send(() => host!.update(scope, set, remove));
  }

  host?.onChanged((payload) => {
    if (payload.scope !== scope) return;
    accept(payload);
    converge();
  });

  return {
    initial,
    setEntry: (k, v) => {
      const cur = getRecord();
      if (Object.is(ownValue(cur, k), v)) return;
      const next = { ...cur };
      setOwnValue(next, k, v);
      setRecord(next);
      send(() => host!.update(scope, { [k]: v } as UserSettingsRecord, []));
    },
    removeEntry: (k) => {
      const cur = getRecord();
      if (!Object.hasOwn(cur, k)) return;
      const next = { ...cur };
      delete next[k];
      setRecord(next);
      send(() => host!.update(scope, {}, [k]));
    },
  };
}
