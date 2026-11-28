// 设置值 / 快捷键覆盖(「string→V 记录」型 zustand store)的读写与跨窗同步:权威存储在主进程文件
//(electron/main/services/user-settings.service,对齐 VSCode 每次修改立即写 settings.json / keybindings.json)。
// 此前存在 renderer localStorage:Chromium 延迟数秒才把它刷到磁盘,改完后主进程崩溃 / 强杀会丢掉刚改的设置。
//
// - 首帧:snapshot() 是同步 IPC,store 创建时(及入口模块定首帧主题时)即拿到当前值,不闪默认值。
// - 写:先乐观更新本窗内存(界面立即反映),再把增量发给 main;main 串行读-改-写并原子写盘后广播新状态。
//   多窗口并发改不同 key 不再互相覆盖(此前 localStorage 读-改-写的跨窗 lost update,race R113)。
// - 收敛:main 每次提交带单调版本;本窗有未回复的写时只记下最新权威状态,写全部回复后整体收敛到它 —— 写失败(超限 /
//   写盘失败)自然回滚到权威值,乱序到达的旧广播也不会把新值改回去。
// - 旧版本兼容(降级 / 再升级,见 user-settings-initial 的 legacy mirror):每次拿到权威新状态,镜像回旧 localStorage 键(旧 id),
//   降级后旧版本看到的就是最新设置;启动时旧键与镜像不同 = 降级期间旧版本改过 → 把它的改动并进文件。从未镜像过且文件不存在
//  (首次从旧版本升级)→ 整份迁入;镜像过而文件不存在(用户删了文件)→ 不回灌,恢复默认。
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
import {
  applyLegacyChanges,
  diffRecords,
  readLegacyChanges,
  toLegacyIds,
  userSettingsHost,
  writeLegacyMirror,
} from './user-settings-initial';

export interface UserSettingsRecordOps<V> {
  /** 启动时的记录(已按 readOpts 规整、已迁移旧 id),store 的初值。 */
  readonly initial: Record<string, V>;
  /** 设单 key(值等于当前内存时 no-op)。 */
  setEntry: (k: string, v: V) => void;
  /** 删单 key(内存里没有时 no-op)。 */
  removeEntry: (k: string) => void;
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
  /** 改过名的 id(旧 id → 新 id):镜像回旧键时写旧 id,旧版本对旧 id 的改动落到新 id。 */
  readonly legacyIds?: Readonly<Record<string, string>>;
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
  // 读盘失败的本次运行(内存记录不是文件内容)不镜像、不并入旧版本改动。
  const mirrorEnabled = snap !== null && !snap.persistBlocked;
  const mirror = (record: unknown): void => {
    if (mirrorEnabled) writeLegacyMirror(legacyKey, toLegacyIds(constrain(record), opts.legacyIds));
  };

  const accept = (state: UserSettingsScopeState): void => {
    // 同版本(main 判定无变化的回复)也重写镜像:启动时并入的改动恰好等于文件现值时,镜像借此跟上,下次启动不再重复并入。
    if (state.version < authVersion) return;
    authVersion = state.version;
    authRecord = state.record;
    mirror(state.record);
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

  // 初值:无 main → 旧 localStorage 记录(只读);首次从旧版本升级(从未镜像过、文件不存在)→ 旧记录并发给 main 迁入;
  // 否则 main 快照,叠上降级期间旧版本的改动(有改动即发给 main 并入文件)。
  let storedRaw: Record<string, V>;
  let working: Record<string, V>;
  let sent = false;
  if (!snap) {
    storedRaw = working = readRecord<V>(legacyKey, readOpts);
  } else if (!mirrorEnabled) {
    storedRaw = working = constrain(snap.record);
  } else {
    const lc = readLegacyChanges<V>(legacyKey, readOpts);
    if (!lc.mirrored && snap.needsImport) {
      storedRaw = working = lc.legacy;
      if (Object.keys(lc.legacy).length > 0) {
        const legacy = lc.legacy;
        send(() => host!.importLegacy(scope, legacy));
        sent = true;
      }
    } else {
      storedRaw = constrain(snap.record);
      working = applyLegacyChanges(storedRaw, lc, opts.legacyIds);
    }
  }
  const initial = migrate ? migrate(working) : working;
  if (initial !== storedRaw) {
    const { set, remove } = diffRecords(storedRaw, initial);
    send(() => host!.update(scope, set, remove));
    sent = true;
  }
  // 没有要发的(旧版本没改过 / 首次镜像):现在就把权威记录镜像回旧键;有要发的 → 等 main 回复新状态时镜像(accept)。
  if (!sent && snap) mirror(snap.record);

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
