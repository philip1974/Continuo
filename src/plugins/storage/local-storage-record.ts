// 可维护性 M21:localStorage 上「string→V 对象」全局配置的持久化 + 跨窗同步样板单一来源。
//
// settings values-store 与 keybindings overrides-store 此前各自手写同一套:从 localStorage
// 读 JSON object(容错 SSR/无 localStorage/解析失败/非对象)、写 JSON object(吞 quota/disabled)、
// 监听 `storage` 事件按 key 重读。抽成 helper,各 store 只保留自己的 key / 值类型 / setState 映射。

import { jsonStringLengthLowerBoundExceeds } from '../../../electron/shared/json-byte-budget';
import { ownValue, setOwnValue } from '../../../electron/shared/own-value';

/**
 * 读 localStorage[key] 的 JSON 对象;无/非对象/解析失败/无 localStorage → {}.
 *
 * 边界(E22):此前「是 object 就强转 Record<string,V>」,不校验 key/value 类型、长度或条目数。
 * 畸形/篡改的 localStorage(如 keybindings overrides 混入非字符串值)会被读进内存,下游
 * getEffectiveHotkey → compileCombo(effective).toLowerCase() 直接崩溃;大量/超长 key 也让 store
 * 初始化/同步卡顿。opts 提供 value 守卫 + 条目/键长上限:非法 value 丢弃,超长 key 跳过,超条目数
 * 截断。**不传 opts 时保持旧行为**(直接强转),兼容未迁移调用方。
 *
 * 边界(E70,E64/E67/E68 解析前上限族):E22 的 maxEntries/maxKeyLength/valueGuard 都在
 * JSON.parse(raw) **之后**才生效,挡不住「解析前」成本。被篡改或旧版本残留的超大 localStorage
 * 字符串会在 renderer 启动 + `storage` 同步事件时造成 parse/枚举卡顿。故先按原始串长度 cap 拦,
 * 超限直接返 {}(同既有 catch→{} 降级语义)。DEFAULT_MAX_RAW_LENGTH 默认上限对所有调用方生效
 *(含未传 opts 者)——纯防御天花板,settings/keybindings 等正常值仅数 KB,1MiB 不会误伤。
 */
const DEFAULT_MAX_RAW_LENGTH = 1024 * 1024; // 1 MiB

function getLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function clearRecord(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // localStorage may be disabled or throwing; readRecord still degrades to {}.
  }
}

/** 清除该 key(localStorage 不可用 / 抛错时静默)。读回发现损坏的调用方用它「清毒」。 */
export function clearStoredKey(key: string): void {
  clearRecord(getLocalStorage(), key);
}

/**
 * Web Storage JSON 读取的公共底层(readRecord、命令面板 recent 列表、marketplace sessionStorage 缓存共用):无 storage /
 * 无值 → undefined;解析前按原始串长度拦(E70/E71,防超大 JSON 的 parse 卡顿),超限或解析失败 → 清除该 key 并
 * 返回 undefined。形态校验由调用方做(不合法时可调 clearStoredKey)。`storage` 缺省 localStorage。
 */
export function readStoredJson(
  key: string,
  maxRawLength = DEFAULT_MAX_RAW_LENGTH,
  storage: Storage | undefined = getLocalStorage(),
): unknown {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    if (raw.length > maxRawLength) {
      clearRecord(storage, key);
      return undefined;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    clearRecord(storage, key);
    return undefined;
  }
}

export interface ReadRecordOptions<V> {
  readonly valueGuard?: (v: unknown) => v is V;
  readonly maxEntries?: number;
  readonly maxKeyLength?: number;
  readonly maxRawLength?: number;
}

export function readRecord<V>(
  key: string,
  opts?: ReadRecordOptions<V>,
): Record<string, V> {
  const parsed = readStoredJson(key, opts?.maxRawLength);
  if (parsed === undefined) return {};
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      clearStoredKey(key);
      return {};
    }
    const constrained =
      opts !== undefined &&
      (opts.valueGuard !== undefined ||
        opts.maxEntries !== undefined ||
        opts.maxKeyLength !== undefined);
    if (!constrained) return parsed as Record<string, V>; // 旧行为:无约束直接强转
    const out: Record<string, V> = {};
    let n = 0;
    // 边界(E198,E197/E176/E189/E192 有界迭代族):单次 for...in 惰性遍历,边计数边过滤,达 maxEntries
    // 立即 break —— 不先 Object.entries 把所有键值对全量物化。1MiB raw cap(E70)是 backstop,但其内仍可
    // 塞大量短 key,旧 Object.entries 在 break 前就全物化 → Settings/Keybindings 启动 / storage 同步时峰值。
    const rec = parsed as Record<string, unknown>;
    for (const k in rec) {
      if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
      if (opts.maxEntries !== undefined && n >= opts.maxEntries) break;
      if (opts.maxKeyLength !== undefined && k.length > opts.maxKeyLength)
        continue;
      const v = rec[k];
      if (opts.valueGuard !== undefined && !opts.valueGuard(v)) continue;
      setOwnValue(out, k, v as V); // `__proto__` 键保留为自有属性(同 JSON.parse 语义)
      n += 1;
    }
    return out;
  } catch {
    clearStoredKey(key);
    return {};
  }
}

/**
 * writeRecord 结果:
 * - `'ok'`        写盘成功。
 * - `'too-large'` 序列化后总串长超读端 readRecord 的 raw cap(E260,写读对称)。**拒写** —— 调用方
 *                 据此**不提交内存态**,否则本会话内存与磁盘发散,且下次启动 readRecord 因超 raw cap
 *                 整表返 {} = 所有数据静默丢失。
 * - `'unavailable'` 无 localStorage / quota / disabled。沿用旧「静默忽略」语义,调用方可保留内存态
 *                 (本会话仍可用),不视为数据丢失风险(非超限,只是没落盘)。
 */
export type WriteRecordResult = 'ok' | 'too-large' | 'unavailable';

/**
 * 写 localStorage[key]。返回写入结果(见 WriteRecordResult)。
 *
 * 边界(E260,写读 cap 对称 / E242/E246/E247/E249/E252 同族):此前写端无总大小上限,但读端
 * readRecord 对原始串有 DEFAULT_MAX_RAW_LENGTH(1MiB)上限 —— 写端可写出读端会整表丢弃的超大记录
 *(多个合法大 text setting 累积),本会话看似成功、下次启动 readRecord 返 {} → **所有 overrides 静默
 * 丢失**。故写端按 JSON.stringify 总串长与读端**同一** cap 对齐:超限返 'too-large' 拒写,调用方不提交
 * 内存态(保留上次有效持久化状态)。
 */
export function writeRecord<V>(
  key: string,
  value: Record<string, V>,
  opts?: { readonly maxRawLength?: number },
): WriteRecordResult {
  const storage = getLocalStorage();
  if (storage === undefined) return 'unavailable';
  const maxRawLength = opts?.maxRawLength ?? DEFAULT_MAX_RAW_LENGTH;
  // 边界(E309,E286 字节预算族 / .length 变体):序列化 .length 下界 > maxRawLength ⇒ 必超限,在
  // JSON.stringify 物化巨字符串之前提前拒(否则超 1MiB 的 settings/keybindings 记录先物化整串才按 .length cap
  // 拒)。.length 度量与读端 readRecord 的 raw.length cap 对齐(jsonByteLowerBoundExceeds 是 UTF-8 字节,
  // 对 .length cap 会误拒 CJK 记录,故用 .length 变体)。
  if (jsonStringLengthLowerBoundExceeds(value, maxRawLength)) {
    return 'too-large';
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 'unavailable';
  }
  if (serialized.length > maxRawLength) {
    return 'too-large';
  }
  try {
    if (storage.getItem(key) === serialized) return 'ok';
  } catch {
    // Ignore getItem failures; setItem below preserves the previous fallback.
  }
  try {
    storage.setItem(key, serialized);
    return 'ok';
  } catch {
    return 'unavailable'; // quota / disabled — 静默(内存态由调用方决定是否保留)
  }
}

/**
 * 监听别的同源 document 对 localStorage[key] 的修改(跨窗口同步)。`storage` 事件仅在
 * **其它** document 改 localStorage 时 fire,故同窗自己的写不会回环。调用方在 onChange 里
 * 重读并 setState,让各窗口收敛一致。无 window / SSR 时返回 no-op cleanup。
 */
export function subscribeStorageKey(key: string, onChange: () => void): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return () => {};
  }
  const handler = (e: StorageEvent): void => {
    if (e.key !== key) return;
    onChange();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export interface RecordStoreOps<V> {
  /** 按 readOpts 重读 live localStorage(含净化/上限)。 */
  read: () => Record<string, V>;
  /** 单 key 写入(读-改-写);值等于 live 记录时不写盘,只把内存收敛到 live。 */
  setEntry: (k: string, v: V) => void;
  /** 删除单 key(读-改-写);live 已无该 key 时不写盘,内存若仍有则收敛到 live。 */
  removeEntry: (k: string) => void;
}

/**
 * localStorage「string→V 对象」型 zustand store 的读-改-写 / 重置 / 跨窗同步样板单一来源
 *(settings values-store 与 keybindings overrides-store 共用;此前两边逐段同构,每次修复须各补一次)。
 * 值的净化(写端校验 / 截断)与 store 特有逻辑(如 reset 通知)留在调用方。
 *
 * - race(R6 + R113):单 key RMW 基于 live localStorage 重读而非本窗内存快照,**缓解但不根除**多窗口
 *   lost update —— Chromium 各 renderer 缓存 localStorage、跨窗写异步广播,两窗仍可基于旧快照互相覆盖。
 *   R113 DEFER(用户决策 2026-06-25):稳健修法=迁主进程串行 delta 写,暂缓。详见 doc/race-condition-audit.md R113。
 * - E260(写读 cap 对称):整份记录序列化超读端 raw cap → 拒写且**不提交内存态**,避免下次启动 readRecord
 *   整表返 {} = 所有 override 静默丢失(保留上次有效状态)。
 * - 跨窗同步(P2-BA):zustand 内存快照只在启动时读一次;监听 `storage` 事件(仅别 document 改时 fire),
 *   同 key 重读让各窗收敛一致(两类配置语义上都是 app 级全局)。
 *
 * `getRecord` / `setRecord` 是对 store 字段的惰性访问器(只在操作 / 事件发生时调用,故可引用稍后才创建的 store)。
 */
export function createRecordStoreOps<V>(opts: {
  readonly key: string;
  readonly readOpts: ReadRecordOptions<V>;
  readonly getRecord: () => Record<string, V>;
  readonly setRecord: (next: Record<string, V>) => void;
  /** E260 拒写时 console.warn 的文案。 */
  readonly tooLargeWarning: string;
}): RecordStoreOps<V> {
  const { key, readOpts, getRecord, setRecord, tooLargeWarning } = opts;
  const read = (): Record<string, V> => readRecord<V>(key, readOpts);
  // 写端 cap 与读端同一来源(E260 写读对称;未传 maxRawLength 时两端都用默认 1MiB)。
  const write = (next: Record<string, V>): WriteRecordResult =>
    writeRecord(key, next, { maxRawLength: readOpts.maxRawLength ?? DEFAULT_MAX_RAW_LENGTH });
  const convergeTo = (latest: Record<string, V>): void => {
    if (!recordsShallowEqual(getRecord(), latest)) setRecord(latest);
  };
  subscribeStorageKey(key, () => convergeTo(read()));
  return {
    read,
    setEntry: (k, v) => {
      const latest = read();
      if (Object.is(ownValue(latest, k), v)) {
        convergeTo(latest);
        return;
      }
      const next = { ...latest, [k]: v };
      if (write(next) === 'too-large') {
        console.warn(tooLargeWarning);
        return;
      }
      setRecord(next);
    },
    removeEntry: (k) => {
      const latest = read();
      if (!Object.hasOwn(latest, k)) {
        // 别窗可能已删该 key;本窗内存若仍有则收敛到 latest。
        if (Object.hasOwn(getRecord(), k)) setRecord(latest);
        return;
      }
      const next = { ...latest };
      delete next[k];
      write(next);
      setRecord(next);
    },
  };
}

/** 两个 record 的自有可枚举键集合相同且各值 Object.is 相等(store 无变化时返回原 state 用)。 */
export function recordsShallowEqual<V>(
  a: Record<string, V>,
  b: Record<string, V>,
): boolean {
  if (a === b) return true;
  let aCount = 0;
  let bCount = 0;
  for (const key in a) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) continue;
    aCount += 1;
    if (!Object.is(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    bCount += 1;
  }
  return aCount === bCount;
}
