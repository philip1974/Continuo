// EditorHeader 右侧工具按钮贡献(M-Plugin v3.2)。
// when 谓词决定可见,EditorHeader 每帧渲染前过滤;subscribe 用于热增减按钮。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

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

// 边界(E51,E35-E50 兄弟 registry):register 接受插件 EditorActionSpec 无运行时校验。id/label 无长度
// 上限,priority 可 NaN/Infinity,when/fn 未确认是函数。畸形 action 进 editor header 排序+渲染;超长
// label 污染按钮文本/aria-label,NaN priority 让排序比较器失真,非函数 when/fn 在渲染过滤或点击执行
// 时反复抛错。注册入口校验 id/label 非空限长 + priority finite + when/fn 为函数,非法抛不入(渲染层
// filterVisible 的单项 when try/catch 隔离保留)。
const EA_ID_MAX = 256;
const EA_LABEL_MAX = 512;

function validateEditorActionSpec(spec: EditorActionSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[editor-action-registry] spec must be an object');
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[editor-action-registry] id must be a non-empty string');
  }
  if (spec.id.length > EA_ID_MAX) {
    throw new Error(
      `[editor-action-registry] id exceeds max length ${EA_ID_MAX}`,
    );
  }
  if (typeof spec.label !== 'string' || spec.label.length === 0) {
    throw new Error('[editor-action-registry] label must be a non-empty string');
  }
  if (spec.label.length > EA_LABEL_MAX) {
    throw new Error(
      `[editor-action-registry] label exceeds max length ${EA_LABEL_MAX}`,
    );
  }
  if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
    throw new Error('[editor-action-registry] priority must be finite');
  }
  if (spec.when !== undefined && typeof spec.when !== 'function') {
    throw new Error('[editor-action-registry] when must be a function');
  }
  if (typeof spec.fn !== 'function') {
    throw new Error('[editor-action-registry] fn must be a function');
  }
}

export class EditorActionRegistry {
  private items = new Map<string, EditorActionSpec>();
  private listeners = new Set<Listener>();
  private cachedAll: readonly EditorActionSpec[] | null = null;

  register(spec: EditorActionSpec): Disposable {
    validateEditorActionSpec(spec); // 边界(E51):注册前校验长度/priority finite/when·fn 为函数
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('editor-action-registry', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[editor-action-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.id, spec);
    this.invalidateSnapshotCache();
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.invalidateSnapshotCache();
          this.notify();
        }
      },
    };
  }

  getAll(): readonly EditorActionSpec[] {
    if (this.cachedAll !== null) return this.cachedAll;

    const items: EditorActionSpec[] = [];
    for (const item of this.items.values()) items.push(item);
    items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.cachedAll = items;
    return items;
  }

  /**
   * race(R53,R51/R52 同族):按 id 取当前 live editor action(已 unregister 返 undefined)。
   * EditorHeader 的按钮 onClick 捕获了 EditorActionSpec,插件 disable/reload 同步 unregister 后、
   * 到 React 重渲移除按钮前旧 handler 仍可触发 → click 时用本方法从 registry 重查 + 重检 when
   * 再执行,死 action / 当前 ctx 下不可见的 action 静默忽略。
   */
  get(id: string): EditorActionSpec | undefined {
    return this.items.get(id);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private invalidateSnapshotCache(): void {
    this.cachedAll = null;
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
