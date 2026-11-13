// Map 型插件贡献 registry 的共享基类(重构:Command / EditorAction / ExplorerContextMenu / Panel /
// Ribbon / SettingItem / SettingTab / StatusBar 此前各自逐字复制同一段注册/dispose/订阅样板)。
//
// 收口动机:该样板上的每个守卫(E236 容量、R51-R59 live get 复查、dispose 只删自己)历史上都要
// 逐个兄弟 registry 传播,漏一个即回归。基类持有 items / listeners 与注册流程,子类只保留:
// 单条 spec 校验、快照缓存(getAll / getBySide / getByCategory)与各自的失效逻辑。
//
// BDD: src/__tests__/keyed-registry-base/

import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';

type Listener = () => void;

export abstract class KeyedRegistry<T> {
  protected readonly items = new Map<string, T>();
  private readonly listeners = new Set<Listener>();

  /**
   * @param registryName 错误 / 告警前缀(如 `ribbon-registry`)
   * @param keyLabel 覆盖告警里 key 的称呼(Panel 以 `type` 为 key,其余为 `id`)
   */
  protected constructor(
    private readonly registryName: string,
    private readonly keyLabel: 'id' | 'type' = 'id',
  ) {}

  /** 子类清自己的快照缓存;入表 / 删除后、通知订阅者前调用。 */
  protected abstract invalidateSnapshotCache(): void;

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
