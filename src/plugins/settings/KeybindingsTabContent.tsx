// 快捷键参考表(Settings → 快捷键 tab)。
// 订阅 commands registry,只列有 hotkey 的命令,按 category 分组。
// KeyCap 渲染 hotkey,跟 CommandPalette 风格一致。

import { useEffect, useMemo, useState } from 'react';
import { IconButton, Input, KeyCap } from '@/design';
import { coApp } from '@/plugins/co-app';
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

const PLATFORM = detectPlatform();
const DEFAULT_GROUP = '其他';

function useCommands(registry: CommandRegistry): readonly CommandSpec[] {
  const [snapshot, setSnapshot] = useState<readonly CommandSpec[]>(() =>
    registry.getAll(),
  );
  useEffect(
    () => registry.subscribe(() => setSnapshot(registry.getAll())),
    [registry],
  );
  return snapshot;
}

interface Bucket {
  readonly category: string;
  readonly items: readonly CommandSpec[];
}

/** 把命令按 category 分组,每组按 title 字母序;空 category 归 DEFAULT_GROUP. */
function groupByCategory(commands: readonly CommandSpec[]): Bucket[] {
  const map = new Map<string, CommandSpec[]>();
  for (const cmd of commands) {
    const key = cmd.category ?? DEFAULT_GROUP;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(cmd);
  }
  return Array.from(map.entries())
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function matches(cmd: CommandSpec, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  const haystack = [
    cmd.title,
    cmd.category ?? '',
    cmd.id,
    cmd.hotkey ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(lower);
}

export function KeybindingsTabContent() {
  const allCommands = useCommands(coApp.commands);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CommandSpec | null>(null);
  // 订阅 overrides 让 effective hotkey 变化触发组件重渲(此处不直接用,
  // 但 selector 订阅就能让 React 在 setHotkey/reset 后重新读 getEffectiveHotkey)
  useKeybindingsStore((s) => s.overrides);
  const setHotkey = useKeybindingsStore((s) => s.setHotkey);
  const reset = useKeybindingsStore((s) => s.reset);
  const overrides = useKeybindingsStore((s) => s.overrides);

  const buckets = useMemo(() => {
    // 列出所有有「有效 hotkey」或「显式 unbind 但有默认」的命令(允许用户回头改)
    const visible = allCommands.filter(
      (c) => c.hotkey || c.id in overrides,
    );
    const filtered = query
      ? visible.filter((c) => matches(c, query))
      : visible;
    return groupByCategory(filtered);
  }, [allCommands, query, overrides]);

  const totalWithHotkey = useMemo(
    () => allCommands.filter((c) => Boolean(c.hotkey)).length,
    [allCommands],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Input
          size="sm"
          placeholder="搜索命令名 / 分类 / 快捷键…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span>共 {totalWithHotkey} 个有快捷键的命令 · 无 hotkey 请用</span>
          <KeyCap>⌘</KeyCap>
          <KeyCap>⇧</KeyCap>
          <KeyCap>P</KeyCap>
          <span>命令面板搜索</span>
        </div>
      </div>

      <KeybindingCaptureModal
        visible={editing !== null}
        commandId={editing?.id ?? ''}
        commandTitle={editing?.title ?? ''}
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
            ? '暂无注册了快捷键的命令'
            : '无匹配命令'}
        </div>
      ) : (
        <div className="space-y-8">
          {buckets.map((bucket) => (
            <section key={bucket.category}>
              <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
                {bucket.category}
              </h3>
              <ul className="overflow-hidden rounded-md border border-line bg-panel-soft/40">
                {bucket.items.map((cmd, idx) => {
                  const effective = getEffectiveHotkey(cmd);
                  const isOverridden = cmd.id in overrides;
                  return (
                    <li
                      key={cmd.id}
                      className={[
                        'flex items-center gap-3 px-4 py-3 text-xs',
                        idx > 0 ? 'border-t border-line/50' : '',
                      ].join(' ')}
                    >
                      <span className="truncate text-sm text-fg">{cmd.title}</span>
                      <code className="ml-auto shrink-0 rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                        {cmd.id}
                      </code>
                      {effective ? (
                        <span className="flex shrink-0 items-center gap-0.5">
                          {formatHotkeyParts(effective, PLATFORM).map((p) => (
                            <KeyCap key={p}>{p}</KeyCap>
                          ))}
                        </span>
                      ) : (
                        <span className="shrink-0 text-2xs text-fg-dim">
                          未绑定
                        </span>
                      )}
                      <IconButton
                        size="xs"
                        title="编辑快捷键"
                        aria-label="编辑快捷键"
                        onClick={() => setEditing(cmd)}
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <path d="M11.5 1.5l3 3-9 9-3.5.5.5-3.5z" />
                        </svg>
                      </IconButton>
                      <IconButton
                        size="xs"
                        title={`恢复默认(${cmd.hotkey ?? '未绑定'})`}
                        aria-label="恢复默认"
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
