// Map 型插件贡献 registry 的共享基类(重构:Command / EditorAction / ExplorerContextMenu / Panel /
// Ribbon / SettingItem / SettingTab / StatusBar 此前各自逐字复制同一段注册/dispose/订阅样板)。
//
// 收口动机:该样板上的每个守卫(E236 容量、R51-R59 live get 复查、dispose 只删自己)历史上都要
// 逐个兄弟 registry 传播,漏一个即回归。基类持有 items / listeners 与注册流程,子类只保留:
// 单条 spec 校验、全量快照的构造(buildSnapshot)与派生快照缓存(getBySide / getByCategory)。
//
// BDD: src/__tests__/keyed-registry-base/

import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';

type Listener = () => void;
const EMPTY_SNAPSHOT: readonly never[] = [];

export abstract class KeyedRegistry<T> {
  protected readonly items = new Map<string, T>();
  private readonly listeners = new Set<Listener>();
  private cachedAll: readonly T[] | null = null;

  /**
   * @param registryName 错误 / 告警前缀(如 `ribbon-registry`)
   * @param keyLabel 覆盖告警里 key 的称呼(Panel 以 `type` 为 key,其余为 `id`)
   */
  protected constructor(
    private readonly registryName: string,
    private readonly keyLabel: 'id' | 'type' = 'id',
  ) {}

  /** 非空表的全量快照(子类决定顺序:插入序 / 按 priority)。结果由基类缓存到下一次变更。 */
  protected abstract buildSnapshot(): readonly T[];

  /** 子类若还有派生快照缓存(按 side / category),在此一并清掉。 */
  protected onSnapshotInvalidated?(): void;

  /**
   * 全量快照。引用稳定:两次变更之间返回同一个数组(useRegistry / memo 友好);空表返回共享空数组。
   * 此前 8 个子类各自持 cachedAll + 同一段「命中缓存 / 空表」前导。
   */
  getAll(): readonly T[] {
    if (this.cachedAll !== null) return this.cachedAll;
    this.cachedAll =
      this.items.size === 0 ? (EMPTY_SNAPSHOT as readonly T[]) : this.buildSnapshot();
    return this.cachedAll;
  }

  private invalidateSnapshotCache(): void {
    this.cachedAll = null;
    this.onSnapshotInvalidated?.();
  }

  /** 容量守卫与覆盖告警之后、入表之前(previous = 被覆盖的旧 spec)。 */
  protected onBeforeSet?(spec: T, previous: T | undefined): void;

  /** dispose 真正删除本 spec 之后、通知之前。 */
  protected onRemoved?(spec: T): void;

  /**
   * 注册流程(子类先做单条 spec 校验再调):
   * 边界(E236)容量守卫,超限抛、不入表 → 覆盖既有 key 告警(后注册赢)→ 入表 → 失效快照 → 通知。
   * 返回的 Disposable 幂等;仅当当前注册的还是 spec 本身才删(防被后注册者顶替后误删)。
   */
  protected registerKeyed(key: string, spec: T): Disposable {
    const previous = this.items.get(key);
    const exists = this.items.has(key);
    assertRegistryCapacity(this.registryName, this.items.size, exists);
    if (exists) {
      console.warn(
        `[${this.registryName}] ${this.keyLabel} "${key}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.onBeforeSet?.(spec, previous);
    this.items.set(key, spec);
    this.invalidateSnapshotCache();
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(key) === spec) {
          this.items.delete(key);
          this.onRemoved?.(spec);
          this.invalidateSnapshotCache();
          this.notify();
        }
      },
    };
  }

  /**
   * 按 key 取当前 live spec(已 unregister 返 undefined)。race(R51-R59 族):UI 侧缓存的旧 spec /
   * useRegistry 快照滞后 registry 一帧,插件 disable/reload 同步 unregister 后旧 handler / render 仍
   * 可能被触发 → 调用方执行前用本方法从 live registry 复查,死条目静默忽略。
   */
  get(key: string): T | undefined {
    return this.items.get(key);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * 按 `priority ?? 100` 升序构造快照(等优先级保持注册顺序:Array.prototype.sort 稳定)。
 * 按 Map size 预分配;遍历时顺带探测是否已有序,有序则跳过 sort(常见:全默认 priority)。
 */
export function snapshotByPriority<T extends { readonly priority?: number }>(
  items: ReadonlyMap<string, T>,
): T[] {
  const out = new Array<T>(items.size);
  let i = 0;
  let prevPriority = -Infinity;
  let sorted = true;
  for (const item of items.values()) {
    const priority = item.priority ?? 100;
    if (priority < prevPriority) sorted = false;
    prevPriority = priority;
    out[i++] = item;
  }
  if (out.length > 1 && !sorted) {
    out.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }
  return out;
}

// filterVisible 用的零拷贝过滤在 @/lib/filter-keeping-identity(notifications / 权限弹窗队列也用)。
export { filterKeepingIdentity } from '@/lib/filter-keeping-identity';
