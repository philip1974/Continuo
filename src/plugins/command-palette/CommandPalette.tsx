// 命令面板 UI(M-Plugin v1.6)。
// 订阅 CommandRegistry → fuzzy 过滤 → design Modal 渲染列表。
// ↑↓ 选中,Enter 执行,Esc / 点遮罩关闭(Modal 内置)。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, Modal } from '@/design';
import type {
  CommandRegistry,
  CommandSpec,
} from '../registries/CommandRegistry';
import { useCommandPaletteStore } from './store';
import { fuzzyFilter } from './fuzzy';

interface CommandPaletteProps {
  readonly commands: CommandRegistry;
}

function useCommands(registry: CommandRegistry): readonly CommandSpec[] {
  const [snapshot, setSnapshot] = useState<readonly CommandSpec[]>(() =>
    registry.getAll(),
  );
  useEffect(() => {
    return registry.subscribe(() => setSnapshot(registry.getAll()));
  }, [registry]);
  return snapshot;
}

export function CommandPalette({ commands }: CommandPaletteProps) {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const query = useCommandPaletteStore((s) => s.query);
  const selectedIndex = useCommandPaletteStore((s) => s.selectedIndex);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const moveSelection = useCommandPaletteStore((s) => s.moveSelection);

  const allCommands = useCommands(commands);
  const filtered = useMemo(
    () => fuzzyFilter(allCommands, query, (c) => c.title),
    [allCommands, query],
  );

  const execute = useCallback(
    async (cmd: CommandSpec) => {
      close();
      try {
        await cmd.fn();
      } catch (err) {
        console.warn(`[command-palette] ${cmd.id} threw`, err);
      }
    },
    [close],
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
      const cmd = filtered[selectedIndex];
      if (cmd) void execute(cmd);
    }
  };

  return (
    <Modal visible={isOpen} onClose={close} className="!p-0 !rounded-md !max-w-[560px]">
      <div className="flex flex-col">
        <div className="border-b border-line p-2">
          <Input
            size="sm"
            autoFocus
            placeholder="输入命令名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-fg-dim">
              {allCommands.length === 0 ? '暂无可用命令' : '无匹配命令'}
            </li>
          ) : (
            filtered.map((cmd, idx) => (
              <li
                key={cmd.id}
                className={[
                  'flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs',
                  idx === selectedIndex
                    ? 'bg-hover text-fg'
                    : 'text-fg-muted hover:bg-hover/50',
                ].join(' ')}
                onClick={() => void execute(cmd)}
                onMouseEnter={() => moveSelection(idx - selectedIndex, filtered.length)}
              >
                <span className="truncate">{cmd.title}</span>
                {cmd.hotkey && (
                  <span className="ml-3 shrink-0 text-[10px] text-fg-dim">
                    {cmd.hotkey}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </Modal>
  );
}
