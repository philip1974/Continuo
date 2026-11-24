// 插件贡献 registry 的最底层共享基类:订阅者集合 + 逐个隔离的通知 + 全量快照缓存。
//
// KeyedRegistry(Map 型,按 id / type 去重覆盖)与 ExplorerDecoratorRegistry(数组型,无 key、同一 fn
// 可重复注册、自带 MAX_DECORATORS)条目存储与注册语义不同,无法共用 registerKeyed;但「变更 → 失效
// 快照 → 通知」与监听器隔离此前在两处平行实现,安全守卫(监听器抛错不打断注册)要两边同步。收口于此。
//
// BDD: src/__tests__/keyed-registry-base/、src/__tests__/explorer-decorator/

type Listener = () => void;
const EMPTY_SNAPSHOT: readonly never[] = [];

export abstract class SnapshotRegistry<T> {
  private readonly listeners = new Set<Listener>();
  private cachedAll: readonly T[] | null = null;

  /** @param registryName 错误 / 告警前缀(如 `ribbon-registry`) */
  protected constructor(protected readonly registryName: string) {}

  /** 当前是否没有条目(空表时 getAll 返回共享空数组,不调 buildSnapshot)。 */
  protected abstract isEmpty(): boolean;

  /** 非空表的全量快照(子类决定顺序)。结果由基类缓存到下一次变更。 */
  protected abstract buildSnapshot(): readonly T[];

  /** 子类若还有派生快照缓存(按 side / category),在此一并清掉。 */
  protected onSnapshotInvalidated?(): void;

  /** 全量快照。引用稳定:两次变更之间返回同一个数组(useRegistry / memo 友好);空表返回共享空数组。 */
  getAll(): readonly T[] {
    if (this.cachedAll !== null) return this.cachedAll;
    this.cachedAll = this.isEmpty() ? (EMPTY_SNAPSHOT as readonly T[]) : this.buildSnapshot();
    return this.cachedAll;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 条目已变更:先失效快照缓存(含子类派生缓存),再同步通知订阅者。 */
  protected changed(): void {
    this.cachedAll = null;
    this.onSnapshotInvalidated?.();
    this.notify();
  }

  // 安全:监听器逐个隔离。subscribe 对插件开放,监听器抛错若冒出 notify,register 会在条目已入表后抛错 ——
  // 调用方拿不到 Disposable(注销不掉),排在后面的监听器(宿主 UI)也收不到这次变更。
  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.warn(`[${this.registryName}] subscribe listener threw`, err);
      }
    }
  }
}
