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
import {
  KeyedRegistry,
  filterKeepingIdentity,
  snapshotByPriority,
} from './keyed-registry';
import {
  SPEC_ID_MAX,
  SPEC_TITLE_MAX,
  assertOptionalFinitePriority,
  assertOptionalSpecFunction,
  assertOptionalSpecString,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
} from './spec-guard';

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


// 边界(E48,E35/E36/E37/E40 兄弟 registry):register 接受插件右键菜单 spec 无运行时校验。id/label/
// group 无长度上限,priority 可 NaN/Infinity,when/fn 也未确认是函数。畸形项进 getAll().sort() +
// 菜单打开时 groupPluginItems() 对超长/异常 group 做 localeCompare/分组渲染;非函数 when/fn 在打开
// 菜单或点击时抛错,影响右键菜单可用性。注册入口校验长度 + priority finite + when/fn 为函数,非法抛
// 不入(菜单渲染层仍保留单项 when try/catch 隔离)。
const EMPTY_VISIBLE_EXPLORER_CONTEXT_MENU_ITEMS: ExplorerContextMenuItemSpec[] =
  [];

function validateContextMenuItemSpec(spec: ExplorerContextMenuItemSpec): void {
  const tag = 'explorer-context-menu';
  assertSpecObject(tag, spec);
  assertSpecString(tag, 'id', spec.id, SPEC_ID_MAX);
  assertSpecString(tag, 'label', spec.label, SPEC_TITLE_MAX);
  // group 会被 groupPluginItems() 当 Map key 并 localeCompare,非字符串会让整个右键菜单渲染崩溃(E155)。
  assertOptionalSpecString(tag, 'group', spec.group, SPEC_ID_MAX);
  assertOptionalFinitePriority(tag, spec.priority);
  assertOptionalSpecFunction(tag, 'when', spec.when);
  assertSpecFunction(tag, 'fn', spec.fn);
}

export class ExplorerContextMenuRegistry extends KeyedRegistry<ExplorerContextMenuItemSpec> {
  constructor() {
    super('explorer-context-menu');
  }

  register(spec: ExplorerContextMenuItemSpec): Disposable {
    validateContextMenuItemSpec(spec); // 边界(E48):注册前校验长度/priority finite/when·fn 为函数
    return this.registerKeyed(spec.id, spec);
  }

  protected buildSnapshot(): readonly ExplorerContextMenuItemSpec[] {
    return snapshotByPriority(this.items);
  }
}

/** 按 ctx 判断单个菜单项是否可见;when 抛错视为 false + warn. */
export function isExplorerContextMenuItemVisible(
  item: ExplorerContextMenuItemSpec,
  ctx: ExplorerContextMenuItemContext,
): boolean {
  if (!item.when) return true;
  try {
    return item.when(ctx);
  } catch (err) {
    console.warn(
      `[explorer-context-menu] when fn for "${item.id}" threw`,
      err,
    );
    return false;
  }
}

/** 按 ctx 过滤可见项;when 抛错视为 false + warn. */
export function filterVisible(
  items: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): ExplorerContextMenuItemSpec[] {
  return filterKeepingIdentity(
    items,
    (item) => isExplorerContextMenuItemVisible(item, ctx),
    EMPTY_VISIBLE_EXPLORER_CONTEXT_MENU_ITEMS,
  );
}
