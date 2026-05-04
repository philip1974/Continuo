// LM 自定义事件总线(M-Plugin v2.2)。
// 命名事件,payload 任意;Plugin 通过 registerEvent 订阅自动 dispose。
//
// 事件名约定 `<scope>.<verb>`,如 'editor.file-saved' / 'panel.opened'。

import type { Disposable } from './types';

type Listener = (payload: unknown) => void;

export class EventBus {
  private byName = new Map<string, Set<Listener>>();

  on(name: string, listener: Listener): Disposable {
    let set = this.byName.get(name);
    if (!set) {
      set = new Set();
      this.byName.set(name, set);
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
