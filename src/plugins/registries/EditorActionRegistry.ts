// EditorHeader 右侧工具按钮贡献(M-Plugin v3.2)。
// when 谓词决定可见,EditorHeader 每帧渲染前过滤;subscribe 用于热增减按钮。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import {
  KeyedRegistry,
  filterKeepingIdentity,
  snapshotByPriority,
} from './keyed-registry';
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


// 边界(E51,E35-E50 兄弟 registry):register 接受插件 EditorActionSpec 无运行时校验。id/label 无长度
// 上限,priority 可 NaN/Infinity,when/fn 未确认是函数。畸形 action 进 editor header 排序+渲染;超长
// label 污染按钮文本/aria-label,NaN priority 让排序比较器失真,非函数 when/fn 在渲染过滤或点击执行
// 时反复抛错。注册入口校验 id/label 非空限长 + priority finite + when/fn 为函数,非法抛不入(渲染层
// filterVisible 的单项 when try/catch 隔离保留)。
const EA_ID_MAX = 256;
const EA_LABEL_MAX = 512;
const EMPTY_VISIBLE_EDITOR_ACTIONS: EditorActionSpec[] = [];

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

export class EditorActionRegistry extends KeyedRegistry<EditorActionSpec> {
  constructor() {
    super('editor-action-registry');
  }

  register(spec: EditorActionSpec): Disposable {
    validateEditorActionSpec(spec); // 边界(E51):注册前校验长度/priority finite/when·fn 为函数
    return this.registerKeyed(spec.id, spec);
  }

  protected buildSnapshot(): readonly EditorActionSpec[] {
    return snapshotByPriority(this.items);
  }
}

/** 按 ctx 判断单个 action 是否可见;when 抛错视为 false + warn. */
export function isEditorActionVisible(
  action: EditorActionSpec,
  ctx: EditorActionContext,
): boolean {
  if (!action.when) return true;
  try {
    return action.when(ctx);
  } catch (err) {
    console.warn(`[editor-action] when fn for "${action.id}" threw`, err);
    return false;
  }
}

/** 按 ctx 过滤可见 actions;when 抛错视为 false + warn. */
export function filterVisible(
  actions: readonly EditorActionSpec[],
  ctx: EditorActionContext,
): EditorActionSpec[] {
  return filterKeepingIdentity(
    actions,
    (a) => isEditorActionVisible(a, ctx),
    EMPTY_VISIBLE_EDITOR_ACTIONS,
  );
}
