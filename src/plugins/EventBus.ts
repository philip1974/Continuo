// LM 自定义事件总线(M-Plugin v2.2)。
// 命名事件,payload 任意;Plugin 通过 registerEvent 订阅自动 dispose。
//
// 事件名约定 `<scope>.<verb>`,如 'editor.file-saved' / 'panel.opened'。

import type { Disposable } from './types';

type Listener = (payload: unknown) => void;

// 边界(E56,插件 API 输入校验):on/emit/clear 对插件传入的事件名和 listener 无运行时校验,也无
// 事件名数量/单事件 listener 数量上限。畸形插件可注册超长/非字符串事件名或成千上万个监听器;
// emit() 会 Array.from(set) 拷贝并同步逐个调用 → 单次事件触发内存峰值 + renderer 卡顿;非函数
// listener 还会每次 emit 反复抛错刷日志。on 入口校验 name 为有限长度字符串 + listener 为函数 +
// 总事件数/每事件 listener 数上限,非法/超限抛、不注册;emit/clear 对非字符串 name no-op。
const EVENT_NAME_MAX = 256;
const MAX_EVENT_NAMES = 1024;
const MAX_LISTENERS_PER_EVENT = 1024;

export class EventBus {
  private byName = new Map<string, Set<Listener>>();

  on(name: string, listener: Listener): Disposable {
    if (typeof name !== 'string' || name.length === 0 || name.length > EVENT_NAME_MAX) {
      throw new Error(
        `[event-bus] event name must be a non-empty string ≤ ${EVENT_NAME_MAX}`,
      );
    }
    if (typeof listener !== 'function') {
      throw new Error('[event-bus] listener must be a function');
    }
    let set = this.byName.get(name);
    if (!set) {
      if (this.byName.size >= MAX_EVENT_NAMES) {
        throw new Error(
          `[event-bus] too many distinct event names (>= ${MAX_EVENT_NAMES})`,
        );
      }
      set = new Set();
      this.byName.set(name, set);
    }
    if (set.size >= MAX_LISTENERS_PER_EVENT) {
      throw new Error(
        `[event-bus] too many listeners for "${name}" (>= ${MAX_LISTENERS_PER_EVENT})`,
      );
    }
    set.add(listener);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.off(name, listener);
      },
    };
  }

  off(name: string, listener: Listener): void {
    const set = this.byName.get(name);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.byName.delete(name);
  }

  emit(name: string, payload: unknown): void {
    if (typeof name !== 'string') return; // 边界(E56):非字符串 name no-op(listener 数已由 on cap)
    const set = this.byName.get(name);
    if (!set) return;
    // 拷贝防 listener 内自取消导致迭代异常
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(`[event-bus] listener for "${name}" threw`, err);
      }
    }
  }

  clear(name?: string): void {
    if (name === undefined) {
      this.byName.clear();
    } else {
      this.byName.delete(name);
    }
  }
}
