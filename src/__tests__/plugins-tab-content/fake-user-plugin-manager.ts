// 测试支架:把只有 listAll(及若干动作)的假 manager 包成 UI 订阅所需的形态。
// 真 PluginManager 的约定:listAll 在两次变化之间返回同一引用,变化时通知 subscribe 的监听者。
// 假 manager 的 listAll 往往每次返回新数组;这里按「代际」缓存,notifyUserPluginListChanged() 推进代际并通知。

interface ListSource {
  listAll: () => readonly unknown[];
}

const wrapped = new WeakMap<object, object>();
const listeners = new Set<() => void>();
let generation = 0;

/** vi.mock('…/PluginManager') 的 getUserPluginManager 用它包一层;null 原样返回。同一个假对象只包一次。 */
export function asSubscribableManager<T extends ListSource>(raw: T | null | undefined): T | null {
  if (!raw) return null;
  const existing = wrapped.get(raw);
  if (existing) return existing as T;
  let cachedGeneration = -1;
  let cached: readonly unknown[] = [];
  const manager = Object.create(raw, {
    listAll: {
      value: () => {
        if (cachedGeneration !== generation) {
          cached = raw.listAll();
          cachedGeneration = generation;
        }
        return cached;
      },
    },
    subscribe: {
      value: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  }) as T;
  wrapped.set(raw, manager);
  return manager;
}

/** 模拟 PluginManager 的列表变化通知(假 manager 的 listAll 结果变了之后调用)。 */
export function notifyUserPluginListChanged(): void {
  generation += 1;
  for (const listener of [...listeners]) listener();
}
