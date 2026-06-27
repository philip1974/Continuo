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
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

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

// 边界(E48,E35/E36/E37/E40 兄弟 registry):register 接受插件右键菜单 spec 无运行时校验。id/label/
// group 无长度上限,priority 可 NaN/Infinity,when/fn 也未确认是函数。畸形项进 getAll().sort() +
// 菜单打开时 groupPluginItems() 对超长/异常 group 做 localeCompare/分组渲染;非函数 when/fn 在打开
// 菜单或点击时抛错,影响右键菜单可用性。注册入口校验长度 + priority finite + when/fn 为函数,非法抛
// 不入(菜单渲染层仍保留单项 when try/catch 隔离)。
const CM_ID_MAX = 256;
const CM_LABEL_MAX = 512;
const CM_GROUP_MAX = 256;

function validateContextMenuItemSpec(spec: ExplorerContextMenuItemSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[explorer-context-menu] spec must be an object');
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[explorer-context-menu] id must be a non-empty string');
  }
  if (spec.id.length > CM_ID_MAX) {
    throw new Error(`[explorer-context-menu] id exceeds max length ${CM_ID_MAX}`);
  }
  if (typeof spec.label !== 'string' || spec.label.length === 0) {
    throw new Error('[explorer-context-menu] label must be a non-empty string');
  }
  if (spec.label.length > CM_LABEL_MAX) {
    throw new Error(
      `[explorer-context-menu] label exceeds max length ${CM_LABEL_MAX}`,
    );
  }
  if (spec.group !== undefined) {
    // 边界(E155,E153/E154 兄弟):group 为可选 string,来自未类型化 JS plugin。E48 只对它做
    // .length 上限缺 typeof(`({}).length === undefined > max` 为 false 绕过)→ group:{}/group:123
    // 进 registry,菜单打开时 groupPluginItems() 把 group 当 Map key 并在排序里 localeCompare,
    // 非字符串使整个右键菜单渲染崩溃。长度校验前先 typeof。
    if (typeof spec.group !== 'string') {
      throw new Error('[explorer-context-menu] group must be a string');
    }
    if (spec.group.length > CM_GROUP_MAX) {
      throw new Error(
        `[explorer-context-menu] group exceeds max length ${CM_GROUP_MAX}`,
      );
    }
  }
  if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
    throw new Error('[explorer-context-menu] priority must be finite');
  }
  if (spec.when !== undefined && typeof spec.when !== 'function') {
    throw new Error('[explorer-context-menu] when must be a function');
  }
  if (typeof spec.fn !== 'function') {
    throw new Error('[explorer-context-menu] fn must be a function');
  }
}

export class ExplorerContextMenuRegistry {
  private items = new Map<string, ExplorerContextMenuItemSpec>();
  private listeners = new Set<Listener>();
  private cachedAll: readonly ExplorerContextMenuItemSpec[] | null = null;

  register(spec: ExplorerContextMenuItemSpec): Disposable {
    validateContextMenuItemSpec(spec); // 边界(E48):注册前校验长度/priority finite/when·fn 为函数
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('explorer-context-menu', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[explorer-context-menu] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getAll(): readonly ExplorerContextMenuItemSpec[] {
    if (this.cachedAll !== null) return this.cachedAll;

    const items = new Array<ExplorerContextMenuItemSpec>(this.items.size);
    let i = 0;
    for (const item of this.items.values()) items[i++] = item;
    items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.cachedAll = items;
    return items;
  }

  /**
   * race(R54,R51/R52/R53 同族):按 id 取当前 live 右键菜单项(已 unregister 返 undefined)。
   * ContextMenu 在打开时把 spec 缓存进 pluginGroups,onSelect 捕获 item.fn;菜单打开期间插件
   * disable/reload 同步 unregister 后旧菜单仍可触发 → select 时用本方法重查 + 用当前 ctx 复检
   * when 再执行,死项 / 当前 ctx 下不可见项静默忽略。
   */
  get(id: string): ExplorerContextMenuItemSpec | undefined {
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

/** 按 ctx 过滤可见项;when 抛错视为 false + warn. */
export function filterVisible(
  items: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): ExplorerContextMenuItemSpec[] {
  const out = new Array<ExplorerContextMenuItemSpec>(items.length);
  let count = 0;
  for (const item of items) {
    if (!item.when) {
      out[count++] = item;
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
    if (visible) out[count++] = item;
  }
  out.length = count;
  return out;
}
