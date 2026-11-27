// Quick Open「转到编辑器中的符号」模式(查询以 `@` 开头;⇧⌘O 打开时预填)。对齐 VSCode GotoSymbolQuickAccessProvider:
// - 目标 = 触发窗口的编辑器组(commandEditorGroupId)的活动编辑器;Markdown 的符号 = 标题(三种模式都可跳,见
//   markdown-symbol-navigation);没有文本编辑器 / 不是 Markdown(本项目无语言服务)/ 没有标题 / 无匹配 → VSCode 同款提示;
// - `@` 后的文字模糊过滤(按标题文字;同分按文档顺序);空查询按文档顺序、初始选中光标所在的节;
// - `@:` 按类别分组(Markdown 标题只有「字符串」一类,首行标「字符串 (N)」;`@` 首行标「符号 (N)」);
// - 移动选中项 → 编辑器跟随预览(居中,焦点留在输入框);Enter 跳转、焦点交给编辑器并记入导航历史;
//   Esc 取消 / 删掉 `@` 离开该模式 → 回到打开前的光标与滚动位置。
// BDD: src/__tests__/markdown-outline/

import { useEffect, useMemo, useRef, useState } from 'react';
import { translateCount, useT } from '@/i18n';
import { normalizeSearchQuery } from '@/lib/search-query';
import { commandEditorGroupId } from '@/panels/Editor/editor-groups-actions';
import {
  currentSymbolOrdinal,
  resolveSymbolTarget,
  revealSymbol,
  snapshotSymbolTarget,
  type SymbolTarget,
  type SymbolTargetSnapshot,
} from '@/panels/Editor/markdown-symbol-navigation';
import {
  cachedMarkdownOutline,
  markdownOutlineOf,
  type MarkdownOutline,
  type MarkdownSymbol,
} from '@/panels/Editor/markdown-outline-model';
import { fuzzyFilter } from '../command-palette/fuzzy';
import { useQuickOpenStore } from './store';

/** 转到符号模式的查询前缀(VSCode 同:⇧⌘O 打开 Quick Open 并预填它)。 */
export const GOTO_SYMBOL_PREFIX = '@';
/** `@:` = 按类别分组(VSCode SCOPE_PREFIX)。 */
const SCOPE_PREFIX = ':';

export function isGotoSymbolQuery(query: string): boolean {
  return query.startsWith(GOTO_SYMBOL_PREFIX);
}

/** `@` / `@:` 查询 → 是否分组 + 过滤词。 */
export function parseGotoSymbolQuery(query: string): { readonly scoped: boolean; readonly filter: string } {
  const rest = query.slice(GOTO_SYMBOL_PREFIX.length);
  const scoped = rest.startsWith(SCOPE_PREFIX);
  return { scoped, filter: normalizeSearchQuery(scoped ? rest.slice(SCOPE_PREFIX.length) : rest) };
}

export interface GotoSymbolState {
  readonly active: boolean;
  /** 过滤后的符号(按显示顺序)。 */
  readonly items: readonly MarkdownSymbol[];
  /** 过滤词(行内高亮用)。 */
  readonly filter: string;
  /** 符号所在的上级标题名称(VSCode 行描述 = 容器名);顶层无。 */
  readonly containerOf: (symbol: MarkdownSymbol) => string | undefined;
  /** 首行右侧的分组标签(「符号 (N)」/「字符串 (N)」);无结果为空。 */
  readonly groupLabel: string;
  /** 无结果时的提示(无编辑器 / 不提供符号 / 无符号 / 无匹配);有结果或仍在解析为空。 */
  readonly message: string;
  /** Enter / 单击:跳到第 index 项并关闭。 */
  readonly accept: (index: number) => void;
}

const NO_ITEMS: readonly MarkdownSymbol[] = [];

function lowerText(s: MarkdownSymbol): string {
  return s.text.toLowerCase();
}

export function useGotoSymbol(query: string, selectedIndex: number, close: () => void): GotoSymbolState {
  const t = useT();
  const active = isGotoSymbolQuery(query);
  // 进入该模式时取一次目标与原位置(模式内不再变化)
  const target = useMemo<SymbolTarget | null>(() => (active ? resolveSymbolTarget(commandEditorGroupId()) : null), [active]);
  const snapshotRef = useRef<SymbolTargetSnapshot | null>(null);
  const acceptedRef = useRef(false);
  // 本次进入模式的初始选中(见下方预览)
  const initialRef = useRef<{ done: boolean; symbol: MarkdownSymbol | undefined }>({ done: false, symbol: undefined });
  const content = target && target.kind !== 'none' && target.kind !== 'unsupported' ? target.content : null;
  const [outline, setOutline] = useState<MarkdownOutline | null>(() =>
    content === null ? null : (cachedMarkdownOutline(content) ?? null),
  );
  const { scoped, filter } = active ? parseGotoSymbolQuery(query) : { scoped: false, filter: '' };

  // 进入模式:记下原位置;离开模式 / Quick Open 关闭而未确认 → 恢复
  useEffect(() => {
    if (!target) return;
    acceptedRef.current = false;
    initialRef.current = { done: false, symbol: undefined };
    const snapshot = snapshotSymbolTarget(target);
    snapshotRef.current = snapshot;
    return () => {
      snapshotRef.current = null;
      if (!acceptedRef.current) snapshot.restore();
    };
  }, [target]);

  // 解析(首次加载解析器;同一文本走缓存)
  useEffect(() => {
    if (content === null) {
      setOutline(null);
      return;
    }
    const cached = cachedMarkdownOutline(content);
    if (cached) {
      setOutline(cached);
      return;
    }
    let cancelled = false;
    markdownOutlineOf(content).then(
      (o) => {
        if (!cancelled) setOutline(o);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [content]);

  const containers = useMemo(() => {
    const map = new Map<MarkdownSymbol, string>();
    const walk = (list: readonly MarkdownSymbol[], parent: MarkdownSymbol | null): void => {
      for (const sym of list) {
        if (parent) map.set(sym, parent.name);
        walk(sym.children, sym);
      }
    };
    if (outline) walk(outline.roots, null);
    return map;
  }, [outline]);

  const items = useMemo(
    () => (outline ? (filter ? fuzzyFilter(outline.flat, filter, lowerText) : outline.flat) : NO_ITEMS),
    [outline, filter],
  );

  // 符号就绪时(每次进入模式一次):空查询初始选中光标所在的节(VSCode 同),编辑器不动 —— 之后用户移动选中项才跟随预览
  //(不抢焦点、不记导航)。
  const selected = items[selectedIndex];
  useEffect(() => {
    if (!target || !outline || acceptedRef.current) return;
    const initial = initialRef.current;
    if (!initial.done) {
      initial.done = true;
      const at = filter ? -1 : currentSymbolOrdinal(target, outline);
      initial.symbol = at >= 0 ? outline.flat[at] : undefined;
      if (at >= 0 && at !== selectedIndex) {
        useQuickOpenStore.setState({ selectedIndex: at });
        return;
      }
    }
    // 初始选中项不预览(编辑器已在该节);键入过滤 / 移动后照常预览
    if (!selected || (selected === initial.symbol && !filter)) return;
    initial.symbol = undefined;
    void revealSymbol(target, selected, { focus: false, record: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随目标 / 符号 / 选中项 / 过滤词变化
  }, [target, outline, selected, filter]);

  const accept = (index: number): void => {
    const symbol = items[index];
    if (!target || !symbol) return;
    acceptedRef.current = true;
    const before = snapshotRef.current?.selection;
    close();
    // Modal 关闭时把焦点还给打开前的元素(可能不是编辑器,如从命令面板执行)→ 下一帧再定位并交给编辑器
    requestAnimationFrame(() => {
      void revealSymbol(target, symbol, { focus: true, record: true, ...(before ? { before } : {}) });
    });
  };

  let message = '';
  let groupLabel = '';
  if (active && target) {
    if (target.kind === 'none') message = t('quick_open.symbol.no_editor');
    else if (target.kind === 'unsupported') message = t('quick_open.symbol.no_provider');
    else if (outline && outline.flat.length === 0) message = t('quick_open.symbol.no_symbols');
    else if (outline && items.length === 0) message = t('quick_open.symbol.no_match');
    else if (items.length > 0) {
      groupLabel = translateCount(scoped ? 'quick_open.symbol.group_strings' : 'quick_open.symbol.group_symbols', items.length);
    }
  }
  return { active, items, filter, containerOf: (sym) => containers.get(sym), groupLabel, message, accept };
}
