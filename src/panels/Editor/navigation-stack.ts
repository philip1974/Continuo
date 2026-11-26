// 编辑器导航栈(后退 / 前进;对齐 VSCode HistoryService 的 EditorNavigationStack,默认范围)。纯数据结构,不依赖 store / 视图。
// - 当前位置(current,VSCode currentSelectionState)随活动编辑器 / 其光标的每次通知更新;
// - 换编辑器、或同一编辑器里光标相对当前位置移动 ≥ NAVIGATION_LINE_THRESHOLD 行 → 新记一条;否则替换当前这条(记最新光标);
// - 新记时截掉前进部分;超出 NAVIGATION_STACK_MAX 丢最旧;
// - 执行后退 / 前进期间(navigating)的通知只更新当前位置,不记录;
// - 文件删除 → 剔除条目、相邻重复合并、位置回到栈尾(VSCode remove);移动 → 同前缀改写、合并。
// BDD: src/__tests__/editor-navigation-history/

import { isSameOrInsidePath } from '@/lib/path-cross';

/** 栈上限(VSCode EditorNavigationStack.MAX_STACK_SIZE)。 */
export const NAVIGATION_STACK_MAX = 50;
/** 同一编辑器内光标移动 ≥ 该行数才算新的导航位置(VSCode TextEditorPaneSelection.TEXT_EDITOR_SELECTION_THRESHOLD)。 */
export const NAVIGATION_LINE_THRESHOLD = 10;

/** 文本编辑器里的光标:恢复用 line / column(1 起);比较用 startLine(选区起止中较小的行,VSCode 同)。 */
export interface NavigationSelection {
  readonly line: number;
  readonly column: number;
  readonly startLine: number;
}

/** 一条导航记录:编辑器组 + 文件 + 光标(Markdown 编辑 / 预览、图片等无光标 → 只记文件)。 */
export interface NavigationLocation {
  readonly groupId: string;
  readonly path: string;
  readonly selection?: NavigationSelection | undefined;
}

function sameEditor(a: NavigationLocation, b: NavigationLocation): boolean {
  return a.groupId === b.groupId && a.path === b.path;
}

/** cur → next 是否算新的导航位置(VSCode EditorSelectionState.justifiesNewNavigationEntry)。 */
function justifiesNewEntry(cur: NavigationLocation, next: NavigationLocation): boolean {
  if (!sameEditor(cur, next) || !cur.selection || !next.selection) return true;
  return Math.abs(cur.selection.startLine - next.selection.startLine) >= NAVIGATION_LINE_THRESHOLD;
}

/** 栈里的 entry 是否该被 candidate 原位替换(VSCode shouldReplaceStackEntry)。 */
function shouldReplace(entry: NavigationLocation, candidate: NavigationLocation): boolean {
  if (!sameEditor(entry, candidate)) return false;
  if (!entry.selection) return true;
  if (!candidate.selection) return false;
  return entry.selection.startLine === candidate.selection.startLine;
}

export class EditorNavigationStack {
  private stack: NavigationLocation[] = [];
  private position = -1;
  private current: NavigationLocation | null = null;

  get entries(): readonly NavigationLocation[] {
    return this.stack;
  }

  get index(): number {
    return this.position;
  }

  /** 当前位置(最近一次通知;未知 → null)。 */
  get currentLocation(): NavigationLocation | null {
    return this.current;
  }

  canGoBack(): boolean {
    return this.position > 0;
  }

  canGoForward(): boolean {
    return this.position < this.stack.length - 1;
  }

  /** 活动编辑器 / 其光标变了。navigating = 正在执行后退 / 前进(只更新当前位置)。 */
  notify(loc: NavigationLocation, navigating = false): void {
    const cur = this.current;
    // 同一编辑器又来一次只记文件的通知 → 保留已知的光标
    if (cur && sameEditor(cur, loc) && !loc.selection) return;
    this.current = loc;
    if (navigating) return;
    const replace = cur !== null && !justifiesNewEntry(cur, loc);
    this.addOrReplace(loc, replace);
  }

  /**
   * 当前这条原位换成 loc(⌃Tab 连按途经的编辑器不各记一条:只留最后落到的)。与前一条成了同一位置 → 合并。栈空 → 同 notify。
   */
  replaceCurrent(loc: NavigationLocation): void {
    if (this.position < 0) {
      this.notify(loc);
      return;
    }
    this.current = loc;
    this.stack[this.position] = loc;
    this.flatten();
  }

  private addOrReplace(loc: NavigationLocation, forceReplace: boolean): void {
    const entry = this.stack[this.position];
    if (entry && sameEditor(entry, loc) && (forceReplace || shouldReplace(entry, loc))) {
      this.stack[this.position] = loc;
      return;
    }
    this.stack = this.stack.slice(0, this.position + 1);
    this.stack.push(loc);
    if (this.stack.length > NAVIGATION_STACK_MAX) this.stack.shift();
    this.position = this.stack.length - 1;
  }

  back(): NavigationLocation | undefined {
    if (!this.canGoBack()) return undefined;
    return this.stack[--this.position];
  }

  forward(): NavigationLocation | undefined {
    if (!this.canGoForward()) return undefined;
    return this.stack[++this.position];
  }

  /** 剔除 isGone(path) 为真的条目(文件 / 目录被删除、切换工作区根);位置回到栈尾。 */
  remove(isGone: (path: string) => boolean): void {
    if (this.current && isGone(this.current.path)) this.current = null;
    const kept = this.stack.filter((e) => !isGone(e.path));
    if (kept.length === this.stack.length) return;
    this.stack = kept;
    this.flatten();
    this.position = this.stack.length - 1;
  }

  /** 文件 / 目录 oldPath 被移动 / 改名到 newPath:其下条目同前缀改写(平台感知),相邻重复合并;位置跟随所在条目。 */
  move(oldPath: string, newPath: string): void {
    const map = (e: NavigationLocation): NavigationLocation =>
      isSameOrInsidePath(oldPath, e.path) ? { ...e, path: newPath + e.path.slice(oldPath.length) } : e;
    if (this.current) this.current = map(this.current);
    this.stack = this.stack.map(map);
    this.flatten();
  }

  /** 相邻的同一位置合并为一条(VSCode flatten);位置落到它所在条目合并后的那条。 */
  private flatten(): void {
    const out: NavigationLocation[] = [];
    let position = -1;
    for (let i = 0; i < this.stack.length; i++) {
      const entry = this.stack[i]!;
      const prev = out[out.length - 1];
      if (!(prev && shouldReplace(entry, prev))) out.push(entry);
      if (i === this.position) position = out.length - 1;
    }
    this.stack = out;
    this.position = Math.min(position, out.length - 1);
  }
}
