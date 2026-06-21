// 快捷键参考表(Settings → 快捷键 tab)。
// 订阅 commands registry,只列有 hotkey 的命令,按 category 分组。
// KeyCap 渲染 hotkey,跟 CommandPalette 风格一致。

import { useMemo, useState } from 'react';
import { IconButton, Input, KeyCap } from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '../registries/useRegistry';
import type {
  CommandRegistry,
  CommandSpec,
} from '@/plugins/registries/CommandRegistry';
import {
  formatHotkeyParts,
  detectPlatform,
} from '@/plugins/command-palette/format-hotkey';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '@/plugins/keybindings/keybindings-store';
import { KeybindingCaptureModal } from '@/plugins/keybindings/KeybindingCaptureModal';
import { useT, useTWithFallback, useLocale } from '@/i18n';

const PLATFORM = detectPlatform();

function useCommands(registry: CommandRegistry): readonly CommandSpec[] {
  return useRegistry(registry);
}

interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
  /** 预计算的 effective hotkey(含 user override;无则 undefined)(打磨 R29). */
  readonly effectiveHotkey: string | undefined;
  /** 预计算的 hotkey 段(无则空数组). */
  readonly hotkeyParts: readonly string[];
  /** 该命令是否被用户 override(决定 reset 按钮可见). */
  readonly isOverridden: boolean;
}

interface Bucket {
  readonly category: string;
  readonly items: readonly DisplayCommand[];
}

/** 按 displayCategory 分组,每组按 displayTitle 字母序;空 category 归 defaultGroup. */
function groupByCategory(
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
  return Array.from(map.entries())
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) =>
        a.displayTitle.localeCompare(b.displayTitle),
      ),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function matches(d: DisplayCommand, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  // haystack 用 effective hotkey(含 override)而非原 cmd.hotkey(打磨 R29):
  // 否则 override 后搜索仍只能命中默认组合,与列表显示的 effective 不一致。
  const haystack = [
    d.displayTitle,
    d.displayCategory,
    d.cmd.id,
    d.effectiveHotkey ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(lower);
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
    return allCommands.map((cmd) => {
      const effective = getEffectiveHotkey(cmd);
      return {
        cmd,
        displayTitle: tk(cmd.titleKey, cmd.title),
        displayCategory: tk(cmd.categoryKey, cmd.category ?? ''),
        effectiveHotkey: effective ?? undefined,
        hotkeyParts: effective ? formatHotkeyParts(effective, PLATFORM) : [],
        isOverridden: cmd.id in overrides,
      };
    });
  }, [allCommands, tk, overrides, locale]);

  const buckets = useMemo(() => {
    // 列出所有有「有效 hotkey」或「显式 unbind 但有默认」的命令(允许用户回头改)
    const visible = displayCommands.filter(
      (d) => d.cmd.hotkey || d.cmd.id in overrides,
    );
    const filtered = query
      ? visible.filter((d) => matches(d, query))
      : visible;
    return groupByCategory(filtered, t('keybindings.default_group'));
  }, [displayCommands, query, overrides, t]);

  const totalWithHotkey = useMemo(
    () => allCommands.filter((c) => Boolean(c.hotkey)).length,
    [allCommands],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Input
          size="sm"
          placeholder={t('keybindings.search_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span>{t('keybindings.total_summary_prefix', { count: totalWithHotkey })}</span>
          <KeyCap>⌘</KeyCap>
          <KeyCap>⇧</KeyCap>
          <KeyCap>P</KeyCap>
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
        onSave={(combo) => editing && setHotkey(editing.id, combo)}
        onResetToDefault={() => editing && reset(editing.id)}
      />

      {buckets.length === 0 ? (
        <div className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim">
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
                      className={[
                        'flex items-center gap-3 px-4 py-3 text-xs',
                        idx > 0 ? 'border-t border-line/50' : '',
                      ].join(' ')}
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
                        aria-label={t('keybindings.edit_hotkey')}
                        onClick={() => setEditing(cmd)}
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <path d="M11.5 1.5l3 3-9 9-3.5.5.5-3.5z" />
                        </svg>
                      </IconButton>
                      <IconButton
                        size="xs"
                        title={t('keybindings.reset_default', { hotkey: cmd.hotkey ?? t('keybindings.unbound') })}
                        aria-label={t('keybindings.reset_default_aria')}
                        onClick={() => isOverridden && reset(cmd.id)}
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
