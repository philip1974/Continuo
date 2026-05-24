// 命令面板 UI(M-Plugin v1.6 + V2 增强 2026-05)。
// 订阅 CommandRegistry → fuzzy 过滤 → design Modal 渲染列表。
// ↑↓ 选中,Enter 执行,Esc / 点遮罩关闭(Modal 内置)。
//
// V2:
// - CommandSpec 加 category 显示前缀(VSCode 同款 `Settings: Open`)
// - fuzzy 同时匹配 category + title
// - 空 query 时 recent(localStorage 持久化)5 条置顶,其余按 title 字母序
// - execute 后 record 进 recent

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, KeyCap, Modal } from '@/design';
import { useRegistry } from '../registries/useRegistry';
import type {
  CommandRegistry,
  CommandSpec,
} from '../registries/CommandRegistry';
import { useCommandPaletteStore } from './store';
import { fuzzyFilter } from './fuzzy';
import { useRecentCommandsStore } from './recent';
import { formatHotkeyParts, detectPlatform } from './format-hotkey';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../keybindings/keybindings-store';
import { useTWithFallback, useT } from '@/i18n';

// module 顶层一次,renderer 生命周期内不会切平台
const PLATFORM = detectPlatform();

const RECENT_TOP_N = 5;

/** 渲染中间体:已 localize 的 title/category（topic-19 P1-2）。 */
interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
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

export function CommandPalette({ commands }: CommandPaletteProps) {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const moveSelection = useCommandPaletteStore((s) => s.moveSelection);

  const allCommands = useCommands(commands);
  const recentList = useRecentCommandsStore((s) => s.list);
  const recordRecent = useRecentCommandsStore((s) => s.record);
  const recentIds = useMemo(() => recentList.map((e) => e.id), [recentList]);
  // 订阅 overrides:用户改 hotkey 时 CommandPalette 重渲,列表 KeyCap 同步.
  // 不直接用 selector 的值,只为触发 re-render(getEffectiveHotkey 内部读 store).
  useKeybindingsStore((s) => s.overrides);
  const tk = useTWithFallback();
  const t = useT();

  // 先 localize 成 DisplayCommand,再 filter/sort(P1-2: 按显示文本搜索/排序)
  const displayCommands = useMemo<readonly DisplayCommand[]>(
    () =>
      allCommands.map((cmd) => ({
        cmd,
        displayTitle: tk(cmd.titleKey, cmd.title),
        displayCategory: tk(cmd.categoryKey, cmd.category ?? ''),
      })),
    [allCommands, tk],
  );

  const filtered = useMemo(() => {
    if (query) {
      // 有 query → fuzzy 匹配 displayCategory + displayTitle
      return fuzzyFilter(displayCommands, query, matchSource);
    }
    // 空 query → recent 置顶 + 其余按 displayTitle 字母序
    return sortByRecent(displayCommands, recentIds);
  }, [displayCommands, query, recentIds]);

  const execute = useCallback(
    async (cmd: CommandSpec) => {
      close();
      recordRecent(cmd.id);
      try {
        await cmd.fn();
      } catch (err) {
        console.warn(`[command-palette] ${cmd.id} threw`, err);
      }
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
      if (d) void execute(d.cmd);
    }
  };

  return (
    <Modal visible={isOpen} onClose={close} size="md" className="!p-0 !rounded-md">
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
        <ul
          role="listbox"
          aria-label={t('command_palette.list_aria')}
          className="max-h-[360px] overflow-y-auto py-1"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-fg-dim">
              {allCommands.length === 0
                ? t('command_palette.empty')
                : t('command_palette.no_match')}
            </li>
          ) : (
            filtered.map((d, idx) => (
              <li
                key={d.cmd.id}
                role="option"
                aria-selected={idx === selectedIndex}
                className={[
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs',
                  // selectedIndex 跟键盘走;鼠标 hover 用独立的 hover:bg-hover/50
                  idx === selectedIndex
                    ? 'bg-hover text-fg'
                    : 'text-fg-muted hover:bg-hover/50',
                ].join(' ')}
                onClick={() => void execute(d.cmd)}
              >
                {d.displayCategory && (
                  <span className="shrink-0 text-fg-dim">{d.displayCategory}:</span>
                )}
                <span className="truncate">{d.displayTitle}</span>
                {(() => {
                  // 用 effective(含 user override)而非原 spec.hotkey,
                  // 让用户改 hotkey 后命令面板列表立刻显示新组合.
                  const effective = getEffectiveHotkey(d.cmd);
                  return effective ? (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      {formatHotkeyParts(effective, PLATFORM).map((p) => (
                        <KeyCap key={p}>{p}</KeyCap>
                      ))}
                    </span>
                  ) : null;
                })()}
              </li>
            ))
          )}
        </ul>
      </div>
    </Modal>
  );
}
