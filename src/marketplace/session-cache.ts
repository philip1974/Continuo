// 可维护性 M19:marketplace 数据的 sessionStorage 缓存样板单一来源。
//
// index(fetcher.ts)与 reviews(reviews-fetcher.ts)此前各自实现同一套:模块级
// memoryCache + readSessionCache(JSON.parse 容错 + 局部形态校验)+ writeSessionCache +
// 新鲜度判断 + reset 清 memory/sessionStorage。抽成泛型 helper,各 fetcher 只保留自己的
// key / 数据类型 / validate。
//
// 序列化形态 `{ fetchedAt, data }` 由本 helper 对称读写;sessionStorage 不跨应用重启,
// 故内部 wrapper 形态非外部契约,旧条目读不出时按 cache-miss 处理(无害,触发一次重拉)。

interface Wrapped<T> {
  readonly fetchedAt: number;
  readonly data: T;
}

// 边界(E5):时钟偏移容差。fetchedAt 略大于 now(系统时钟微调)是正常的,允许 1min 内;明显未来
// 时间(损坏/篡改的 sessionStorage)拒收 —— 否则 Date.now() - fetchedAt < 0 < ttlMs 恒为「新鲜」。
const FUTURE_SKEW_MS = 60_000;

// 边界(E71,E70 sessionStorage 孪生 / E64/E67/E68 解析前上限族):validate() 的字段/条目限制
// 都在 JSON.parse(raw) **之后**才生效。被篡改或旧版本残留的超大 sessionStorage 缓存会在
// Marketplace 打开时阻塞 renderer。故先按原始串长度 cap 拦,超限按 cache-miss 并清毒(removeItem)。
// 默认上限须覆盖最大合法缓存:index ≤ ~4MiB(E64 MAX_INDEX_BYTES)、reviews 多节点累积也在数 MiB,
// 16MiB 留足余量;调用方可按需传更紧的 maxRawLength。
const DEFAULT_MAX_RAW_LENGTH = 16 * 1024 * 1024;

export interface SessionCache<T> {
  /** memory 优先(miss 则 hydrate from sessionStorage);新鲜则返数据,过期/无 → null. */
  getFresh(): T | null;
  /** 返任意(含过期)缓存数据;无 → null。网络/IPC 失败时退守用. */
  getStale(): T | null;
  /** 写入(更新 memory + sessionStorage,打 Date.now() 时间戳). */
  set(data: T): void;
  /** 清 memory + sessionStorage(reset / 测试隔离用). */
  reset(): void;
}

export function createSessionCache<T>(opts: {
  readonly key: string;
  readonly ttlMs: number;
  /** JSON.parse 后的数据形态校验(拒形态不符的脏缓存). */
  readonly validate: (data: unknown) => data is T;
  /** 边界(E71):解析前原始串长度上限,默认 16MiB。 */
  readonly maxRawLength?: number;
}): SessionCache<T> {
  let memory: Wrapped<T> | null = null;

  function clearStorage(): void {
    try {
      sessionStorage.removeItem(opts.key);
    } catch {
      /* */
    }
  }

  function readStorage(): Wrapped<T> | null {
    try {
      const raw = sessionStorage.getItem(opts.key);
      if (!raw) return null;
      // 边界(E71):解析前按原始串长度拦,防超大缓存的 JSON.parse 卡顿。超限 = 篡改/旧残留 →
      // cache-miss + 清毒(removeItem),避免坏缓存反复触发解析。
      if (raw.length > (opts.maxRawLength ?? DEFAULT_MAX_RAW_LENGTH)) {
        clearStorage();
        return null;
      }
      const parsed = JSON.parse(raw) as { fetchedAt?: unknown; data?: unknown };
      // 边界(E5):时间戳须有限、非负、非明显未来。畸形 sessionStorage 可写 1e309(JSON.parse →
      // Infinity,typeof 仍是 'number')或超大未来值,使 `Date.now() - fetchedAt < ttlMs` 恒为真 →
      // marketplace index/reviews 永久用陈旧缓存,远端更新/修复不可见直到手动清。非法 wrapper 按
      // cache miss(返 null → 触发重拉)。
      const ts = parsed.fetchedAt;
      if (
        typeof ts !== 'number' ||
        !Number.isFinite(ts) ||
        ts < 0 ||
        ts > Date.now() + FUTURE_SKEW_MS
      ) {
        clearStorage();
        return null;
      }
      if (!opts.validate(parsed.data)) {
        clearStorage();
        return null;
      }
      return { fetchedAt: ts, data: parsed.data };
    } catch {
      clearStorage();
      return null;
    }
  }

  function hydrate(): Wrapped<T> | null {
    if (!memory) memory = readStorage();
    return memory;
  }

  return {
    getFresh() {
      const c = hydrate();
      return c && Date.now() - c.fetchedAt < opts.ttlMs ? c.data : null;
    },
    getStale() {
      return hydrate()?.data ?? null;
    },
    set(data) {
      const next: Wrapped<T> = { fetchedAt: Date.now(), data };
      memory = next;
      try {
        sessionStorage.setItem(opts.key, JSON.stringify(next));
      } catch {
        /* sessionStorage 满 / 禁用 → ignore,memory cache 还在 */
      }
    },
    reset() {
      memory = null;
      clearStorage();
    },
  };
}
