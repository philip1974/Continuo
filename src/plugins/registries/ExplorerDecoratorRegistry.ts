// Explorer 文件树装饰贡献(M-Plugin v3.1)。
// 插件提供 fn(entry) → Decoration | null;FileRow 渲染时合并所有装饰应用到行。

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
}

export type DecoratorFn = (entry: DecoratorEntry) => Decoration | null;

type Listener = () => void;

export class ExplorerDecoratorRegistry {
  private fns: DecoratorFn[] = [];
  private listeners = new Set<Listener>();

  register(fn: DecoratorFn): Disposable {
    this.fns.push(fn);
    this.notify();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const i = this.fns.indexOf(fn);
        if (i >= 0) {
          this.fns.splice(i, 1);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly DecoratorFn[] {
    return this.fns.slice();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * 合并多个装饰器对同一 entry 的输出。
 * - badge / badgeColor:取首个非空
 * - textColor:后者赢
 * - tooltip:全部用 ` · ` 拼接
 * - 单 fn 抛错 → 跳过该 fn,其它继续
 */
export function mergeDecorations(
  entry: DecoratorEntry,
  fns: readonly DecoratorFn[],
): Decoration | null {
  let badge: string | undefined;
  let badgeColor: string | undefined;
  let textColor: string | undefined;
  const tooltips: string[] = [];

  for (const fn of fns) {
    let dec: Decoration | null;
    try {
      dec = fn(entry);
    } catch (err) {
      console.warn('[explorer-decorator] fn threw', err);
      continue;
    }
    if (!dec) continue;
    if (badge === undefined && dec.badge !== undefined) {
      badge = dec.badge;
      badgeColor = dec.badgeColor;
    }
    if (dec.textColor !== undefined) textColor = dec.textColor;
    if (dec.tooltip !== undefined) tooltips.push(dec.tooltip);
  }

  if (
    badge === undefined &&
    textColor === undefined &&
    tooltips.length === 0
  ) {
    return null;
  }
  return {
    badge,
    badgeColor,
    textColor,
    tooltip: tooltips.length > 0 ? tooltips.join(' · ') : undefined,
  };
}
