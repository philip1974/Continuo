// 快捷键参考表(Settings → 快捷键 tab)。
// 订阅 commands registry,只列有 hotkey 的命令,按 category 分组。
// KeyCap 渲染 hotkey,跟 CommandPalette 风格一致。

import { useEffect, useMemo, useState } from 'react';
import { IconButton, Input, KeyCap } from '@/design';
import { clampSearchQuery } from '@/lib/search-query';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '../registries/useRegistry';
import type {
  CommandRegistry,
  CommandSpec,
} from '@/plugins/registries/CommandRegistry';
import {
  formatHotkeyParts,
  detectPlatform,
  type Platform,
} from '@/plugins/command-palette/format-hotkey';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '@/plugins/keybindings/keybindings-store';
import { KeybindingCaptureModal } from '@/plugins/keybindings/KeybindingCaptureModal';
import { useT, useTWithFallback, useLocale } from '@/i18n';

const PLATFORM = detectPlatform();
const KEYBINDING_ROW_CLASS_NAME =
  'flex items-center gap-3 px-4 py-3 text-xs';
const KEYBINDING_ROW_BORDER_CLASS_NAME =
  `${KEYBINDING_ROW_CLASS_NAME} border-t border-line/50`;

function useCommands(registry: CommandRegistry): readonly CommandSpec[] {
  return useRegistry(registry);
}

export interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
  /** 预计算的 effective hotkey(含 user override;无则 undefined)(打磨 R29). */
  readonly effectiveHotkey: string | undefined;
  /** 预计算的 hotkey 段(无则空数组). */
  readonly hotkeyParts: readonly string[];
  /** 该命令是否被用户 override(决定 reset 按钮可见). */
  readonly isOverridden: boolean;
  /** 搜索用小写 haystack,随命令/语言/override 变化预计算. */
  readonly searchHaystack: string;
}

export interface Bucket {
  readonly category: string;
  readonly items: readonly DisplayCommand[];
}

export function keybindingRowClassName(index: number): string {
  return index > 0
    ? KEYBINDING_ROW_BORDER_CLASS_NAME
    : KEYBINDING_ROW_CLASS_NAME;
}

/** 按 displayCategory 分组,每组按 displayTitle 字母序;空 category 归 defaultGroup. */
export function groupByCategory(
  commands: readonly DisplayCommand[],
  defaultGroup: string,
): Bucket[] {
  const map = new Map<string, DisplayCommand[]>();
  for (const d of commands) {
    const key = d.displayCategory || defaultGroup;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(d);
  }
  const buckets: Bucket[] = [];
  for (const [category, items] of map) {
    items.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    buckets.push({
      category,
      items,
    });
  }
  buckets.sort((a, b) => a.category.localeCompare(b.category));
  return buckets;
}

function matches(d: DisplayCommand, qLower: string): boolean {
  if (!qLower) return true;
  return d.searchHaystack.includes(qLower);
}

export function selectVisibleKeybindingCommands(
  commands: readonly DisplayCommand[],
  query: string,
): DisplayCommand[] {
  const qLower = query.toLowerCase();
  const hasQuery = query.length > 0;
  const selected: DisplayCommand[] = [];

  for (const d of commands) {
    if (!d.cmd.hotkey && !d.isOverridden) continue;
    if (hasQuery && !matches(d, qLower)) continue;
    selected.push(d);
  }

  return selected;
}

export function buildCommandSearchHaystack(
  displayTitle: string,
  displayCategory: string,
  commandId: string,
  effectiveHotkey: string | undefined,
): string {
  return `${displayTitle} ${displayCategory} ${commandId} ${
    effectiveHotkey ?? ''
  }`.toLowerCase();
}

export function countDefaultHotkeys(commands: readonly CommandSpec[]): number {
  let count = 0;
  for (const command of commands) {
    if (command.hotkey) {
      count += 1;
    }
  }
  return count;
}

type TranslateWithFallback = (
  key: string | undefined,
  fallback: string,
) => string;

export function buildKeybindingDisplayCommands(
  allCommands: readonly CommandSpec[],
  tk: TranslateWithFallback,
  overrides: Readonly<Record<string, string>>,
  platform: Platform,
): DisplayCommand[] {
  const out = new Array<DisplayCommand>(allCommands.length);
  for (let i = 0; i < allCommands.length; i++) {
    const cmd = allCommands[i]!;
    const effective = getEffectiveHotkey(cmd);
    const displayTitle = tk(cmd.titleKey, cmd.title);
    const displayCategory = tk(cmd.categoryKey, cmd.category ?? '');
    out[i] = {
      cmd,
      displayTitle,
      displayCategory,
      effectiveHotkey: effective ?? undefined,
      hotkeyParts: effective ? formatHotkeyParts(effective, platform) : [],
      isOverridden: cmd.id in overrides,
      // haystack 用 effective hotkey(含 override)而非原 cmd.hotkey(打磨 R29):
      // 否则 override 后搜索仍只能命中默认组合,与列表显示的 effective 不一致。
      // 打磨 R52:随 displayCommands 预计算,避免每次输入都逐行 join + lower-case。
      searchHaystack: buildCommandSearchHaystack(
        displayTitle,
        displayCategory,
        cmd.id,
        effective,
      ),
    };
  }
  return out;
}

export function hasCommandId(
  commands: readonly CommandSpec[],
  id: string,
): boolean {
  for (const command of commands) {
    if (command.id === id) return true;
  }
  return false;
}

export function KeybindingsTabContent() {
  const allCommands = useCommands(coApp.commands);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CommandSpec | null>(null);
  const setHotkey = useKeybindingsStore((s) => s.setHotkey);
  const reset = useKeybindingsStore((s) => s.reset);
  // 订阅 overrides:下方过滤/列表直接读它,且这一个 selector 订阅就能让
  // setHotkey/reset 后 effective hotkey 变化触发组件重渲(打磨 R3:删除原先
  // 多余的第二个裸订阅,单订阅已足够)。
  const overrides = useKeybindingsStore((s) => s.overrides);
  const t = useT();
  const tk = useTWithFallback();
  // locale 失效键(打磨 R31):tk identity 稳定,切语言不会让下面 memo 重算 →
  // displayTitle/displayCategory 会停留旧语言。用 locale 值驱动重算。
  const locale = useLocale();

  const displayCommands = useMemo<readonly DisplayCommand[]>(() => {
    void overrides; // deps:getEffectiveHotkey/isOverridden 依赖 overrides
    void locale; // deps:tk 内部按 locale 翻译
    return buildKeybindingDisplayCommands(allCommands, tk, overrides, PLATFORM);
  }, [allCommands, tk, overrides, locale]);

  const buckets = useMemo(() => {
    // 列出所有有「有效 hotkey」或「显式 unbind 但有默认」的命令(允许用户回头改)
    const filtered = selectVisibleKeybindingCommands(displayCommands, query);
    return groupByCategory(filtered, t('keybindings.default_group'));
  }, [displayCommands, query, t]);

  const totalWithHotkey = useMemo(
    () => countDefaultHotkeys(allCommands),
    [allCommands],
  );

  // race(R50):快捷键编辑弹窗持有打开时捕获的 editing command。若弹窗打开期间插件 reload/disable
  // 把该命令移出 registry,onSave/onReset 仍会用旧 command id 写 override → 写到已不存在的命令,
  // 同 id 命令日后重注册时意外继承旧绑定(stale write)。命令从 allCommands 消失即自动关闭弹窗。
  useEffect(() => {
    if (editing && !hasCommandId(allCommands, editing.id)) {
      setEditing(null);
    }
  }, [editing, allCommands]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Input
          size="sm"
          // a11y(A5 同族):placeholder 无参数 → 复用作 aria-label。
          aria-label={t('keybindings.search_placeholder')}
          placeholder={t('keybindings.search_placeholder')}
          value={query}
          onChange={(e) => setQuery(clampSearchQuery(e.target.value))}
        />
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span>{t('keybindings.total_summary_prefix', { count: totalWithHotkey })}</span>
          {formatHotkeyParts('mod+shift+p', PLATFORM).map((p, i) => (
            <KeyCap key={i}>{p}</KeyCap>
          ))}
          <span>{t('keybindings.total_summary_suffix')}</span>
        </div>
      </div>

      <KeybindingCaptureModal
        visible={editing !== null}
        commandId={editing?.id ?? ''}
        commandTitle={editing ? tk(editing.titleKey, editing.title) : ''}
        currentHotkey={editing ? getEffectiveHotkey(editing) : undefined}
        defaultHotkey={editing?.hotkey}
        allCommands={allCommands}
        onClose={() => setEditing(null)}
        onSave={(combo) => {
          // race(R50):保存瞬间从当前 registry 复检命令仍存在(覆盖 effect 关闭弹窗前的同帧
          // 点击);已移除则关弹窗不写,防 override 写到不存在的命令。
          if (!editing) return;
          if (!hasCommandId(allCommands, editing.id)) {
            setEditing(null);
            return;
          }
          setHotkey(editing.id, combo);
        }}
        onResetToDefault={() => {
          if (!editing) return;
          if (!hasCommandId(allCommands, editing.id)) {
            setEditing(null);
            return;
          }
          reset(editing.id);
        }}
      />

      {buckets.length === 0 ? (
        // a11y(A57,A54/A56 同族):焦点锁搜索框,输入致空时须 live region(role=status)播报无匹配。
        <div
          role="status"
          className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim"
        >
          {totalWithHotkey === 0
            ? t('keybindings.empty')
            : t('keybindings.no_match')}
        </div>
      ) : (
        <div className="space-y-8">
          {buckets.map((bucket) => (
            <section key={bucket.category}>
              <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
                {bucket.category}
              </h3>
              <ul className="overflow-hidden rounded-md border border-line bg-panel-soft/40">
                {bucket.items.map((d, idx) => {
                  const cmd = d.cmd;
                  const { hotkeyParts, isOverridden } = d; // 预计算(打磨 R29)
                  return (
                    <li
                      key={cmd.id}
                      className={keybindingRowClassName(idx)}
                    >
                      <span className="truncate text-sm text-fg">{d.displayTitle}</span>
                      <code className="ml-auto shrink-0 rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                        {cmd.id}
                      </code>
                      {hotkeyParts.length > 0 ? (
                        <span className="flex shrink-0 items-center gap-0.5">
                          {hotkeyParts.map((p) => (
                            <KeyCap key={p}>{p}</KeyCap>
                          ))}
                        </span>
                      ) : (
                        <span className="shrink-0 text-2xs text-fg-dim">
                          {t('keybindings.unbound')}
                        </span>
                      )}
                      <IconButton
                        size="xs"
                        title={t('keybindings.edit_hotkey')}
                        // a11y(A76,A75 同族):多命令行的编辑按钮可见图标通用,aria-label 补命令名以区分。
                        aria-label={t('keybindings.edit_hotkey_for_aria', {
                          command: d.displayTitle,
                        })}
                        onClick={() => setEditing(cmd)}
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <path d="M11.5 1.5l3 3-9 9-3.5.5.5-3.5z" />
                        </svg>
                      </IconButton>
                      <IconButton
                        size="xs"
                        title={t('keybindings.reset_default', { hotkey: cmd.hotkey ?? t('keybindings.unbound') })}
                        aria-label={t('keybindings.reset_default_for_aria', {
                          command: d.displayTitle,
                        })}
                        onClick={() => isOverridden && reset(cmd.id)}
                        // a11y(A12 同族):未覆盖时 disabled,避免键盘 Tab 到不可见无效按钮。
                        disabled={!isOverridden}
                        className={
                          isOverridden ? '' : 'pointer-events-none invisible'
                        }
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
                          <path d="M13 3v3h-3" />
                        </svg>
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
