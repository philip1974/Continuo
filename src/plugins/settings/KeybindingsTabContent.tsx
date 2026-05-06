// 快捷键参考表(Settings → 快捷键 tab)。
// 订阅 commands registry,只列有 hotkey 的命令,按 category 分组。
// KeyCap 渲染 hotkey,跟 CommandPalette 风格一致。

import { useEffect, useMemo, useState } from 'react';
import { Input, KeyCap } from '@/design';
import { coApp } from '@/plugins/co-app';
import type {
  CommandRegistry,
  CommandSpec,
} from '@/plugins/registries/CommandRegistry';
import {
  formatHotkeyParts,
  detectPlatform,
} from '@/plugins/command-palette/format-hotkey';

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

  const buckets = useMemo(() => {
    const withHotkey = allCommands.filter((c) => Boolean(c.hotkey));
    const filtered = query
      ? withHotkey.filter((c) => matches(c, query))
      : withHotkey;
    return groupByCategory(filtered);
  }, [allCommands, query]);

  const totalWithHotkey = useMemo(
    () => allCommands.filter((c) => Boolean(c.hotkey)).length,
    [allCommands],
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Input
          size="sm"
          placeholder="搜索命令名 / 分类 / 快捷键…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="text-[10px] text-fg-dim">
          共 {totalWithHotkey} 个有快捷键的命令(无 hotkey 的命令请用
          <KeyCap>⌘</KeyCap>
          <KeyCap>⇧</KeyCap>
          <KeyCap>P</KeyCap> 调命令面板搜索)
        </div>
      </div>

      {buckets.length === 0 ? (
        <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
          {totalWithHotkey === 0
            ? '暂无注册了快捷键的命令'
            : '无匹配命令'}
        </div>
      ) : (
        <div className="space-y-3">
          {buckets.map((bucket) => (
            <section key={bucket.category} className="space-y-1">
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
                {bucket.category}
              </h3>
              <ul className="overflow-hidden rounded border border-line bg-panel-soft/40">
                {bucket.items.map((cmd, idx) => (
                  <li
                    key={cmd.id}
                    className={[
                      'flex items-center gap-3 px-3 py-1.5 text-xs',
                      idx > 0 ? 'border-t border-line' : '',
                    ].join(' ')}
                  >
                    <span className="truncate text-fg">{cmd.title}</span>
                    <code className="ml-auto shrink-0 text-[10px] text-fg-dim">
                      {cmd.id}
                    </code>
                    {cmd.hotkey && (
                      <span className="flex shrink-0 items-center gap-0.5">
                        {formatHotkeyParts(cmd.hotkey, PLATFORM).map((p, i) => (
                          <KeyCap key={`${p}-${i}`}>{p}</KeyCap>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
