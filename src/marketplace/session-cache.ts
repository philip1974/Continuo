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
}): SessionCache<T> {
  let memory: Wrapped<T> | null = null;

  function readStorage(): Wrapped<T> | null {
    try {
      const raw = sessionStorage.getItem(opts.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { fetchedAt?: unknown; data?: unknown };
      if (typeof parsed.fetchedAt !== 'number') return null;
      if (!opts.validate(parsed.data)) return null;
      return { fetchedAt: parsed.fetchedAt, data: parsed.data };
    } catch {
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
      try {
        sessionStorage.removeItem(opts.key);
      } catch {
        /* */
      }
    },
  };
}
