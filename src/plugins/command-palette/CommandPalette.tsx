// 命令面板 UI(M-Plugin v1.6 + V2 增强 2026-05)。
// 订阅 CommandRegistry → fuzzy 过滤 → design Modal 渲染列表。
// ↑↓ 选中,Enter 执行,Esc / 点遮罩关闭(Modal 内置)。
//
// V2:
// - CommandSpec 加 category 显示前缀(VSCode 同款 `Settings: Open`)
// - fuzzy 同时匹配 category + title
// - 空 query 时 recent(localStorage 持久化)5 条置顶,其余按 title 字母序
// - execute 后 record 进 recent

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Input, KeyCap, Modal } from '@/design';
import { useRegistry } from '../registries/useRegistry';
import type { CommandRegistry, CommandSpec } from '../registries/CommandRegistry';
import { useCommandPaletteStore } from './store';
import { fuzzyFilter } from './fuzzy';
import { useRecentCommandsStore, type RecentEntry } from './recent';
import { formatHotkeyParts, detectPlatform, type Platform } from './format-hotkey';
import { getEffectiveHotkey, useKeybindingsStore } from '../keybindings/keybindings-store';
import { useTWithFallback, useT, useLocale } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';

// module 顶层一次,renderer 生命周期内不会切平台
const PLATFORM = detectPlatform();

const RECENT_TOP_N = 5;
const COMMAND_PALETTE_ROW_BASE_CLASS_NAME =
  'flex cursor-pointer items-center gap-2 px-3 text-xs';
const COMMAND_PALETTE_ROW_SELECTED_CLASS_NAME =
  `${COMMAND_PALETTE_ROW_BASE_CLASS_NAME} bg-hover text-fg`;
const COMMAND_PALETTE_ROW_IDLE_CLASS_NAME =
  `${COMMAND_PALETTE_ROW_BASE_CLASS_NAME} text-fg-muted hover:bg-hover/50`;

export function commandPaletteRowClassName(selected: boolean): string {
  return selected
    ? COMMAND_PALETTE_ROW_SELECTED_CLASS_NAME
    : COMMAND_PALETTE_ROW_IDLE_CLASS_NAME;
}

export function isCommandPaletteVirtualIndexRendered(
  virtualItems: readonly { readonly index: number }[],
  selectedIndex: number,
): boolean {
  for (const item of virtualItems) {
    if (item.index === selectedIndex) return true;
  }
  return false;
}

/** 渲染中间体:已 localize 的 title/category（topic-19 P1-2）。 */
export interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
  /** 预计算的 effective hotkey 段(打磨 R28:从每行 render 移到命令/overrides 变化时). */
  readonly hotkeyParts: readonly string[];
  /** fuzzyFilter 用的预小写 target,随 title/category/locale 变化重算. */
  readonly matchSourceLower: string;
}

function matchSource(d: DisplayCommand): string {
  return d.displayCategory ? `${d.displayCategory} ${d.displayTitle}` : d.displayTitle;
}

function matchSourceLower(d: DisplayCommand): string {
  return d.matchSourceLower;
}

type TranslateWithFallback = (
  key: string | undefined,
  fallback: string,
) => string;

const EMPTY_DISPLAY_COMMANDS: DisplayCommand[] = [];
const EMPTY_RECENT_COMMAND_IDS: string[] = [];
const EMPTY_HOTKEY_PARTS: readonly string[] = [];

export function buildDisplayCommands(
  allCommands: readonly CommandSpec[],
  tk: TranslateWithFallback,
  platform: Platform,
): DisplayCommand[] {
  if (allCommands.length === 0) return EMPTY_DISPLAY_COMMANDS;
  const out = new Array<DisplayCommand>(allCommands.length);
  for (let i = 0; i < allCommands.length; i++) {
    const cmd = allCommands[i]!;
    const effective = getEffectiveHotkey(cmd);
    const displayTitle = tk(cmd.titleKey, cmd.title);
    const displayCategory = tk(cmd.categoryKey, cmd.category ?? '');
    const source = displayCategory
      ? `${displayCategory} ${displayTitle}`
      : displayTitle;
    out[i] = {
      cmd,
      displayTitle,
      displayCategory,
      hotkeyParts: effective ? formatHotkeyParts(effective, platform) : EMPTY_HOTKEY_PARTS,
      // 打磨 R54:配合 fuzzyFilter(getStrLower),搜索输入变化时不再逐命令
      // 对 displayCategory/title 组成的 target 重复 toLowerCase。
      matchSourceLower: source.toLowerCase(),
    };
  }
  return out;
}

export function buildRecentCommandIds(
  recentList: readonly RecentEntry[],
): string[] {
  if (recentList.length === 0) return EMPTY_RECENT_COMMAND_IDS;
  const out = new Array<string>(recentList.length);
  for (let i = 0; i < recentList.length; i++) {
    out[i] = recentList[i]!.id;
  }
  return out;
}

function isSortedByDisplayTitle(items: readonly DisplayCommand[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1]!.displayTitle.localeCompare(items[i]!.displayTitle) > 0) {
      return false;
    }
  }
  return true;
}

/** 空 query 时:recent 前 N 个置顶 + 其余按 displayTitle 字母序. */
export function sortByRecent(
  items: readonly DisplayCommand[],
  recentIds: readonly string[],
): DisplayCommand[] {
  if (items.length === 0) return EMPTY_DISPLAY_COMMANDS;
  if (items.length === 1) return items as DisplayCommand[];
  if (recentIds.length === 0) {
    if (isSortedByDisplayTitle(items)) return items as DisplayCommand[];

    const out = new Array<DisplayCommand>(items.length);
    for (let i = 0; i < items.length; i++) out[i] = items[i]!;
    out.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    return out;
  }
  if (recentIds.length === 1) {
    const recentId = recentIds[0]!;
    let recent: DisplayCommand | undefined;
    const others = new Array<DisplayCommand>(items.length);
    let otherCount = 0;
    for (const d of items) {
      if (d.cmd.id === recentId) recent = d;
      else others[otherCount++] = d;
    }
    others.length = otherCount;
    if (!recent) {
      if (isSortedByDisplayTitle(items)) return items as DisplayCommand[];
      if (otherCount > 1) {
        others.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
      }
      return others;
    }
    if (otherCount > 1 && !isSortedByDisplayTitle(others)) {
      others.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    }
    const out = new Array<DisplayCommand>(items.length);
    let count = 0;
    out[count++] = recent;
    for (const d of others) {
      out[count++] = d;
    }
    out.length = count;
    return out;
  }

  const recentRank = new Map<string, number>();
  for (let i = 0; i < recentIds.length && i < RECENT_TOP_N; i++) {
    recentRank.set(recentIds[i]!, i);
  }
  const recent: (DisplayCommand | undefined)[] = [];
  const others = new Array<DisplayCommand>(items.length);
  let otherCount = 0;
  for (const d of items) {
    const rank = recentRank.get(d.cmd.id);
    if (rank === undefined) others[otherCount++] = d;
    else recent[rank] = d;
  }
  others.length = otherCount;
  others.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
  const out = new Array<DisplayCommand>(items.length);
  let count = 0;
  for (const d of recent) {
    if (d) out[count++] = d;
  }
  for (const d of others) {
    out[count++] = d;
  }
  out.length = count;
  return out;
}

interface CommandPaletteProps {
  readonly commands: CommandRegistry;
}

function useCommands(registry: CommandRegistry): readonly CommandSpec[] {
  return useRegistry(registry);
}

/**
 * 轻量 shell(打磨 R32):CommandPalette 常驻挂在 App 顶层。外层只订阅 isOpen/close
 * 并渲染 Modal,**仅 isOpen 时才挂载 CommandPaletteBody** —— 关闭状态下不再为不可见
 * 列表订阅 commands/recent/overrides/locale 或重算 display/filter/sort。命令注册、
 * 切语言、改快捷键、recent 更新在面板关闭时不再触发任何派生。
 */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const close = useCommandPaletteStore((s) => s.close);
  const t = useT(); // a11y(A13):给无标题 dialog 命名
  return (
    <Modal
      visible={isOpen}
      onClose={close}
      size="md"
      className="!p-0 !rounded-md"
      // a11y(A13):无可见标题的 dialog → 用 aria-label 给屏幕阅读器命名(复用 placeholder key)。
      aria-label={t('command_palette.placeholder')}
    >
      {isOpen && <CommandPaletteBody commands={commands} />}
    </Modal>
  );
}

function CommandPaletteBody({ commands }: CommandPaletteProps) {
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const moveSelection = useCommandPaletteStore((s) => s.moveSelection);
  const clampSelection = useCommandPaletteStore((s) => s.clampSelection);

  const allCommands = useCommands(commands);
  const recentList = useRecentCommandsStore((s) => s.list);
  const recordRecent = useRecentCommandsStore((s) => s.record);
  const recentIds = useMemo(() => buildRecentCommandIds(recentList), [recentList]);
  // 订阅 overrides:用户改 hotkey 时 displayCommands 重算 hotkeyParts(打磨 R28:
  // 之前只为触发 re-render、行内逐行读 store;现把 overrides 接住进 deps,
  // hotkeyParts 在命令/overrides 变化时一次性预计算)。
  const overrides = useKeybindingsStore((s) => s.overrides);
  const tk = useTWithFallback();
  const t = useT();
  // locale 失效键(打磨 R31):useTWithFallback 返回函数 identity 稳定,切语言只重渲
  // 不会让下面的 memo 重算 → 标题/分类/搜索源会停留旧语言。用 locale 值驱动重算。
  const locale = useLocale();
  const placeholderLabel = t('command_palette.placeholder');

  // 先 localize 成 DisplayCommand,再 filter/sort(P1-2: 按显示文本搜索/排序)。
  // hotkeyParts 用 effective(含 user override)预计算,行渲染只读它(R28)。
  const displayCommands = useMemo<readonly DisplayCommand[]>(() => {
    void overrides; // 仅作 deps:getEffectiveHotkey 内部读 store,override 变须重算
    void locale; // 仅作 deps:tk 内部按 locale 翻译,切语言须重算
    return buildDisplayCommands(allCommands, tk, PLATFORM);
  }, [allCommands, tk, overrides, locale]);

  const filtered = useMemo(() => {
    if (query) {
      // 有 query → fuzzy 匹配 displayCategory + displayTitle
      return fuzzyFilter(displayCommands, query, matchSource, matchSourceLower);
    }
    // 空 query → recent 置顶 + 其余按 displayTitle 字母序
    return sortByRecent(displayCommands, recentIds);
  }, [displayCommands, query, recentIds]);

  // 虚拟化列表(打磨 R48,复用 QuickOpen R25 模式):filtered 仍是逻辑全集,但只
  // 渲染可视行,插件命令增多时打开/搜索/键盘移动不再 reconcile 全列表。
  const ROW_H = 30; // li: py-1.5 text-xs ≈ 30px
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });
  // race(R49,R48 孪生):filtered 随 commands registry / 插件 reload·disable / locale·hotkey·recent
  // 重算而动态变短时,把 selectedIndex 钳回 [0,len-1],防 Enter 读 filtered[idx]=undefined 命令
  // 无法执行 + 高亮/滚动悬空。须在下方 scroll effect 之前生效(声明在前)。
  useEffect(() => {
    clampSelection(filtered.length);
  }, [filtered.length, clampSelection]);
  // 键盘改 selectedIndex → 滚到可视区(虚拟化后选中行可能未挂载)。
  useEffect(() => {
    if (filtered.length === 0) return;
    rowVirtualizer.scrollToIndex(selectedIndex);
  }, [selectedIndex, filtered.length, rowVirtualizer]);
  // a11y(A112,A111 后续):aria-activedescendant 只能指向 DOM 中真实挂载的 option。虚拟列表
  // 里选中项可能在逻辑上有效但不在渲染窗口内(scrollToIndex 滚入前的瞬态)→ 须校验该 index
  // 在 getVirtualItems() 渲染窗口内,否则引用悬空,SR 拿不到当前项。
  const activeOptionRendered = isCommandPaletteVirtualIndexRendered(
    rowVirtualizer.getVirtualItems(),
    selectedIndex,
  );

  const execute = useCallback(
    (d: DisplayCommand) => {
      close();
      recordRecent(d.cmd.id);
      // 命令抛错经 runContributedAction 弹 error toast(显示 localize 后的 title),
      // 不再只 console.warn —— 面板已关,旧实现下用户看不到任何失败反馈。见第二十一轮 P1-AX。
      // race(R51):按 id 从 live registry 重查再执行,而非调列表项缓存的 d.cmd.fn()。命令被插件
      // disable/reload unregister 后,filtered 快照仍持旧 CommandSpec;重查使死命令静默忽略。
      runContributedAction(d.displayTitle, () => {
        const live = commands.get(d.cmd.id);
        if (!live) return;
        return live.fn();
      });
    },
    [close, recordRecent, commands],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1, filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1, filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const d = filtered[selectedIndex];
      if (d) execute(d);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          autoFocus
          // a11y(A1):placeholder 不是稳定可访问名(部分 AT 不读 / 输入后消失)。补
          // aria-label 复用同一 placeholder key,给屏幕阅读器稳定的「命令搜索框」名称。
          aria-label={placeholderLabel}
          // a11y(A15):combobox 模式 —— 焦点留输入框、上下键移动 listbox 虚拟选中。须 role=
          // combobox + aria-controls 指向 listbox + aria-activedescendant 指向当前高亮 option,
          // 否则屏幕阅读器按上下键不知高亮哪条。
          role="combobox"
          // a11y(A100):此 modal combobox 打开即弹层可见(无结果也显示「无匹配」空态)→
          // aria-expanded 恒 true 表弹层展开;按结果数设 false 会与可见状态矛盾(宣告 collapsed)。
          // 无结果只移除 aria-activedescendant(下方),不改 expanded。
          aria-expanded
          // a11y(A101,A100 后续):listbox <ul id> 只在有结果时渲染 → 仅有结果时设 aria-controls,
          // 否则引用悬空(指向不存在元素,combobox 关系断裂)。
          aria-controls={
            filtered.length > 0 ? 'command-palette-listbox' : undefined
          }
          // a11y(A111,A101 同族):校验 selectedIndex 不越界,避免结果变短时指向不存在 option。
          aria-activedescendant={
            selectedIndex >= 0 &&
            selectedIndex < filtered.length &&
            activeOptionRendered
              ? `command-palette-option-${selectedIndex}`
              : undefined
          }
          placeholder={placeholderLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={scrollRef} className="max-h-[360px] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          // a11y(A56,A53-A55 同族):焦点锁在搜索框,输入致结果空时须 live region(role=status)
          // 播报「无匹配」,否则 AT 用户不知已无结果。
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {allCommands.length === 0 ? t('command_palette.empty') : t('command_palette.no_match')}
          </div>
        ) : (
          <ul
            id="command-palette-listbox"
            role="listbox"
            aria-label={t('command_palette.list_aria')}
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const idx = vRow.index;
              const d = filtered[idx]!;
              return (
                <li
                  key={d.cmd.id}
                  id={`command-palette-option-${idx}`}
                  role="option"
                  aria-selected={idx === selectedIndex}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vRow.size,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                  // selectedIndex 跟键盘走;鼠标 hover 用独立的 hover:bg-hover/50
                  className={commandPaletteRowClassName(idx === selectedIndex)}
                  onClick={() => execute(d)}
                >
                  {d.displayCategory && (
                    <span className="shrink-0 text-fg-dim">{d.displayCategory}:</span>
                  )}
                  <span className="truncate">{d.displayTitle}</span>
                  {d.hotkeyParts.length > 0 && (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      {d.hotkeyParts.map((p) => (
                        <KeyCap key={p}>{p}</KeyCap>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
