// Explorer 文件树装饰贡献(M-Plugin v3.1)。
// 插件提供 fn(entry) → Decoration | null;FileRow 渲染时合并所有装饰应用到行。
//
// V2(2026-05):加 icon 字段,plugin 可替换默认 file-icon(file-icon.tsx
// 按扩展名映射的彩色图标)。常见用例:git modified 状态 / 文件加密标记 /
// 第三方语言扩展自带 icon。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

export interface DecoratorEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface Decoration {
  /** 行右侧短标签,如 'M' / '12K' / '+3'. */
  readonly badge?: string;
  /** badge 颜色(任意 CSS color). */
  readonly badgeColor?: string;
  /** 文件名颜色覆盖. */
  readonly textColor?: string;
  /** 追加到 title attr,多个用 · 拼接. */
  readonly tooltip?: string;
  /**
   * V2:替换默认文件图标(getFileIconComponent 按 ext 映射的)。
   * 取首个非空(跟 badge 同款 first-wins)。
   * plugin 可传任意 ReactNode(SVG / <img/> / icon component);建议尺寸
   * 16×16 与默认 ICON_SIZE 一致。
   */
  readonly icon?: ReactNode;
}

export type DecoratorFn = (entry: DecoratorEntry) => Decoration | null;

type Listener = () => void;

// 边界(E54,E47 输入侧对偶):register(fn) 此前信任插件输入,不校验 fn 是函数,也无注册数量上限
//(E47 只限制 decorator 输出字段)。非函数 fn 会在每个可见 FileRow 的 mergeDecorations 中反复抛
// TypeError + 刷 console.warn(虽被 try/catch 兜住);注册成千上万个 decorator 让文件树每行渲染变成
// 无界 O(N) 调用,滚动/展开卡顿。register 入口校验 fn 为函数 + 全局数量上限,非法/超限抛、不入表。
const MAX_DECORATORS = 256;

export class ExplorerDecoratorRegistry {
  private fns: DecoratorFn[] = [];
  private listeners = new Set<Listener>();
  private cachedAll: readonly DecoratorFn[] | null = null;

  register(fn: DecoratorFn): Disposable {
    if (typeof fn !== 'function') {
      throw new Error('[explorer-decorator] register expects a function');
    }
    if (this.fns.length >= MAX_DECORATORS) {
      throw new Error(
        `[explorer-decorator] too many decorators registered (>= ${MAX_DECORATORS})`,
      );
    }
    this.fns.push(fn);
    this.invalidateSnapshotCache();
    this.notify();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const i = this.fns.indexOf(fn);
        if (i >= 0) {
          this.fns.splice(i, 1);
          this.invalidateSnapshotCache();
          this.notify();
        }
      },
    };
  }

  getAll(): readonly DecoratorFn[] {
    if (this.cachedAll !== null) return this.cachedAll;

    const fns: DecoratorFn[] = [];
    for (const fn of this.fns) fns.push(fn);
    this.cachedAll = fns;
    return fns;
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

// 边界(E47,插件输出校验):mergeDecorations 此前信任插件 decorator 返回值,badge/tooltip/
// textColor/badgeColor 不校验类型/长度,tooltips 无数量/总长上限,最后 join(' · ') 塞进每个 FileRow
// 的 title。畸形 decorator 可对每个可见文件返回超长 tooltip/badge 或非字符串值 → 虚拟列表滚动反复
// 拼接巨大 title 卡顿;非字符串 badge 进 React 渲染路径触发异常/怪异输出。合并时只接受有限长度
// 字符串,限制 tooltip 数量 + 合并后总长,非法字段丢弃(保留单 decorator try/catch 隔离)。
const DEC_BADGE_MAX = 64; // 短标签('M'/'12K'/'+3')
const DEC_COLOR_MAX = 64; // CSS color 串
const DEC_TOOLTIP_MAX = 1024; // 单 tooltip
const DEC_TOOLTIPS_COUNT_MAX = 32; // tooltip 数量
const DEC_TOOLTIP_TOTAL_MAX = 4096; // 合并后总长

function decString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max
    ? v
    : undefined;
}

/**
 * 合并多个装饰器对同一 entry 的输出。
 * - badge / badgeColor / icon:取首个非空(first-VALID-wins;非法字段丢弃)
 * - textColor:后者赢(最近的合法覆盖)
 * - tooltip:合法项用 ` · ` 拼接(数量 + 总长上限)
 * - 单 fn 抛错 → 跳过该 fn,其它继续
 */
export function mergeDecorations(
  entry: DecoratorEntry,
  fns: readonly DecoratorFn[],
): Decoration | null {
  let badge: string | undefined;
  let badgeColor: string | undefined;
  let textColor: string | undefined;
  let icon: ReactNode | undefined;
  const tooltips: string[] = [];

  for (const fn of fns) {
    let dec: Decoration | null;
    try {
      dec = fn(entry);
    } catch (err) {
      console.warn('[explorer-decorator] fn threw', err);
      continue;
    }
    if (!dec || typeof dec !== 'object') continue;
    // 边界(E47):badge 只接受有限长度字符串;非法则丢弃,让后续 decorator 的合法 badge 赢
    //(first-VALID-wins)。badgeColor 与 badge 绑定,独立校验。
    if (badge === undefined) {
      const b = decString(dec.badge, DEC_BADGE_MAX);
      if (b !== undefined) {
        badge = b;
        badgeColor = decString(dec.badgeColor, DEC_COLOR_MAX);
      }
    }
    if (icon === undefined && dec.icon !== undefined) {
      icon = dec.icon;
    }
    const tc = decString(dec.textColor, DEC_COLOR_MAX);
    if (tc !== undefined) textColor = tc;
    const tip = decString(dec.tooltip, DEC_TOOLTIP_MAX);
    if (tip !== undefined && tooltips.length < DEC_TOOLTIPS_COUNT_MAX) {
      tooltips.push(tip);
    }
  }

  if (
    badge === undefined &&
    textColor === undefined &&
    icon === undefined &&
    tooltips.length === 0
  ) {
    return null;
  }
  // 边界(E47):合并后总长上限 —— 数量(≤32)×单长(≤1024)已有界,再对 join 结果硬截断兜底。
  let tooltip: string | undefined;
  if (tooltips.length > 0) {
    const joined = tooltips.join(' · ');
    tooltip =
      joined.length > DEC_TOOLTIP_TOTAL_MAX
        ? joined.slice(0, DEC_TOOLTIP_TOTAL_MAX)
        : joined;
  }
  return { badge, badgeColor, textColor, icon, tooltip };
}
