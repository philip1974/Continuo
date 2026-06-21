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
import { useRecentCommandsStore } from './recent';
import { formatHotkeyParts, detectPlatform } from './format-hotkey';
import { getEffectiveHotkey, useKeybindingsStore } from '../keybindings/keybindings-store';
import { useTWithFallback, useT, useLocale } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';

// module 顶层一次,renderer 生命周期内不会切平台
const PLATFORM = detectPlatform();

const RECENT_TOP_N = 5;

/** 渲染中间体:已 localize 的 title/category（topic-19 P1-2）。 */
interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
  /** 预计算的 effective hotkey 段(打磨 R28:从每行 render 移到命令/overrides 变化时). */
  readonly hotkeyParts: readonly string[];
}

function matchSource(d: DisplayCommand): string {
  return d.displayCategory ? `${d.displayCategory} ${d.displayTitle}` : d.displayTitle;
}

/** 空 query 时:recent 前 N 个置顶 + 其余按 displayTitle 字母序. */
function sortByRecent(
  items: readonly DisplayCommand[],
  recentIds: readonly string[],
): DisplayCommand[] {
  const recentSet = new Set(recentIds.slice(0, RECENT_TOP_N));
  const recent: DisplayCommand[] = [];
  const others: DisplayCommand[] = [];
  for (const d of items) {
    if (recentSet.has(d.cmd.id)) recent.push(d);
    else others.push(d);
  }
  recent.sort((a, b) => recentIds.indexOf(a.cmd.id) - recentIds.indexOf(b.cmd.id));
  others.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
  return [...recent, ...others];
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
  return (
    <Modal visible={isOpen} onClose={close} size="md" className="!p-0 !rounded-md">
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

  const allCommands = useCommands(commands);
  const recentList = useRecentCommandsStore((s) => s.list);
  const recordRecent = useRecentCommandsStore((s) => s.record);
  const recentIds = useMemo(() => recentList.map((e) => e.id), [recentList]);
  // 订阅 overrides:用户改 hotkey 时 displayCommands 重算 hotkeyParts(打磨 R28:
  // 之前只为触发 re-render、行内逐行读 store;现把 overrides 接住进 deps,
  // hotkeyParts 在命令/overrides 变化时一次性预计算)。
  const overrides = useKeybindingsStore((s) => s.overrides);
  const tk = useTWithFallback();
  const t = useT();
  // locale 失效键(打磨 R31):useTWithFallback 返回函数 identity 稳定,切语言只重渲
  // 不会让下面的 memo 重算 → 标题/分类/搜索源会停留旧语言。用 locale 值驱动重算。
  const locale = useLocale();

  // 先 localize 成 DisplayCommand,再 filter/sort(P1-2: 按显示文本搜索/排序)。
  // hotkeyParts 用 effective(含 user override)预计算,行渲染只读它(R28)。
  const displayCommands = useMemo<readonly DisplayCommand[]>(() => {
    void overrides; // 仅作 deps:getEffectiveHotkey 内部读 store,override 变须重算
    void locale; // 仅作 deps:tk 内部按 locale 翻译,切语言须重算
    return allCommands.map((cmd) => {
      const effective = getEffectiveHotkey(cmd);
      return {
        cmd,
        displayTitle: tk(cmd.titleKey, cmd.title),
        displayCategory: tk(cmd.categoryKey, cmd.category ?? ''),
        hotkeyParts: effective ? formatHotkeyParts(effective, PLATFORM) : [],
      };
    });
  }, [allCommands, tk, overrides, locale]);

  const filtered = useMemo(() => {
    if (query) {
      // 有 query → fuzzy 匹配 displayCategory + displayTitle
      return fuzzyFilter(displayCommands, query, matchSource);
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
  // 键盘改 selectedIndex → 滚到可视区(虚拟化后选中行可能未挂载)。
  useEffect(() => {
    if (filtered.length === 0) return;
    rowVirtualizer.scrollToIndex(selectedIndex);
  }, [selectedIndex, filtered.length, rowVirtualizer]);

  const execute = useCallback(
    (d: DisplayCommand) => {
      close();
      recordRecent(d.cmd.id);
      // 命令抛错经 runContributedAction 弹 error toast(显示 localize 后的 title),
      // 不再只 console.warn —— 面板已关,旧实现下用户看不到任何失败反馈。见第二十一轮 P1-AX。
      runContributedAction(d.displayTitle, () => d.cmd.fn());
    },
    [close, recordRecent],
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
          placeholder={t('command_palette.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={scrollRef} className="max-h-[360px] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-fg-dim">
            {allCommands.length === 0 ? t('command_palette.empty') : t('command_palette.no_match')}
          </div>
        ) : (
          <ul
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
                  className={[
                    'flex cursor-pointer items-center gap-2 px-3 text-xs',
                    // selectedIndex 跟键盘走;鼠标 hover 用独立的 hover:bg-hover/50
                    idx === selectedIndex ? 'bg-hover text-fg' : 'text-fg-muted hover:bg-hover/50',
                  ].join(' ')}
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
