// EditorHeader 右侧工具按钮贡献(M-Plugin v3.2)。
// when 谓词决定可见,EditorHeader 每帧渲染前过滤;subscribe 用于热增减按钮。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

export interface EditorActionContext {
  /** 当前 active tab 文件路径,可能为 null(未保存草稿). */
  readonly filePath: string | null;
  /** 当前 active tab 是否脏. */
  readonly dirty: boolean;
  /** 当前编辑器 mode(markdown 才有意义). */
  readonly mode: 'edit' | 'source' | 'preview';
}

export interface EditorActionSpec {
  readonly id: string;
  readonly label: string;
  /** 优先于 label 显示(若提供). */
  readonly icon?: ReactNode;
  /** 谓词:返 false 隐藏;抛错视为 false + warn. */
  readonly when?: (ctx: EditorActionContext) => boolean;
  readonly fn: () => void | Promise<void>;
  /** 升序排,默认 100. */
  readonly priority?: number;
}

type Listener = () => void;

export class EditorActionRegistry {
  private items = new Map<string, EditorActionSpec>();
  private listeners = new Set<Listener>();

  register(spec: EditorActionSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[editor-action-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.id, spec);
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly EditorActionSpec[] {
    return Array.from(this.items.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/** 按 ctx 过滤可见 actions;when 抛错视为 false + warn. */
export function filterVisible(
  actions: readonly EditorActionSpec[],
  ctx: EditorActionContext,
): EditorActionSpec[] {
  const out: EditorActionSpec[] = [];
  for (const a of actions) {
    if (!a.when) {
      out.push(a);
      continue;
    }
    let visible = false;
    try {
      visible = a.when(ctx);
    } catch (err) {
      console.warn(`[editor-action] when fn for "${a.id}" threw`, err);
      visible = false;
    }
    if (visible) out.push(a);
  }
  return out;
}
