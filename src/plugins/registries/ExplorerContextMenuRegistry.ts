// 资源管理器右键菜单贡献(M-Plugin V1 + 改进型 V1,2026-05)。
// plugin 通过 registerExplorerContextMenuItem 给 Explorer 右键菜单加项,
// 内置 4 项(新建文件 / 新建文件夹 / 重命名 / 删除)不可覆盖。
//
// 形态参考 EditorActionRegistry(同 register/getAll/subscribe/filterVisible)。
//
// V1 设计(向前兼容):
// - group: string(不限 enum),内置约定 'new'/'edit'/'plugin'/'danger'
// - when: 同步 boolean(将来加 async 用新字段不破坏)
// - icon: ReactNode
// - fn: void | Promise<void>
//
// BDD: src/__tests__/explorer-context-menu/

import type { ReactNode } from 'react';
import type { FileEntry } from '../../../electron/shared/fs-entry';
import type { Disposable } from '../types';

export interface ExplorerContextMenuItemContext {
  /** 右键的目标 entry. null = 空白处右键(根目录场景). */
  readonly target: FileEntry | null;
  /** 当前选中集合. 单选时含 target.path 一项. */
  readonly selectedPaths: ReadonlySet<string>;
  /** workspace root path. */
  readonly rootPath: string;
}

export interface ExplorerContextMenuItemSpec {
  readonly id: string;
  readonly label: string;
  /** 优先于 label 显示(若提供). */
  readonly icon?: ReactNode;
  /**
   * 分组:内置约定 'new' / 'edit' / 'plugin'(默认) / 'danger'。
   * plugin 可任意填字符串,渲染层把不在内置 4 类的归类到 'plugin' 段后字母序.
   */
  readonly group?: string;
  /**
   * 同步谓词:返 false 隐藏;抛错视为 false + warn。
   * 将来加 async when 用新字段不破坏老 plugin。
   */
  readonly when?: (ctx: ExplorerContextMenuItemContext) => boolean;
  /** 升序排,默认 100. */
  readonly priority?: number;
  readonly fn: (
    ctx: ExplorerContextMenuItemContext,
  ) => void | Promise<void>;
}

type Listener = () => void;

export class ExplorerContextMenuRegistry {
  private items = new Map<string, ExplorerContextMenuItemSpec>();
  private listeners = new Set<Listener>();

  register(spec: ExplorerContextMenuItemSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[explorer-context-menu] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getAll(): readonly ExplorerContextMenuItemSpec[] {
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

/** 按 ctx 过滤可见项;when 抛错视为 false + warn. */
export function filterVisible(
  items: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): ExplorerContextMenuItemSpec[] {
  const out: ExplorerContextMenuItemSpec[] = [];
  for (const item of items) {
    if (!item.when) {
      out.push(item);
      continue;
    }
    let visible = false;
    try {
      visible = item.when(ctx);
    } catch (err) {
      console.warn(
        `[explorer-context-menu] when fn for "${item.id}" threw`,
        err,
      );
      visible = false;
    }
    if (visible) out.push(item);
  }
  return out;
}
