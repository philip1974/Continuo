// 用户改快捷键的按键捕获 modal(M-Settings v6.5)。
// 监听全局 keydown,实时把组合呈现成 'mod+shift+x' 形式;Esc=取消,
// Backspace=清空(用户可保存空 = unbind),其它键 = 当前组合。

import { useEffect, useMemo, useState } from 'react';
import { Button, KeyCap, Modal } from '@/design';
import {
  formatHotkeyParts,
  detectPlatform,
} from '@/plugins/command-palette/format-hotkey';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { getEffectiveHotkey } from './keybindings-store';

const PLATFORM = detectPlatform();

interface KeybindingCaptureModalProps {
  readonly visible: boolean;
  readonly commandId: string;
  readonly commandTitle: string;
  readonly currentHotkey: string | undefined;
  readonly defaultHotkey: string | undefined;
  /** 全部命令快照,用于冲突检测. */
  readonly allCommands: readonly CommandSpec[];
  /** 保存为新组合(空 = unbind);null 取消. */
  readonly onSave: (hotkey: string) => void;
  readonly onClose: () => void;
  readonly onResetToDefault: () => void;
}

/** 把 keyboard event 编成 'mod+shift+x' 形式. 单独修饰键 → null(等用户继续按). */
function eventToCombo(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') {
    return null;
  }
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key.toLowerCase());
  return parts.join('+');
}

export function KeybindingCaptureModal({
  visible,
  commandId,
  commandTitle,
  currentHotkey,
  defaultHotkey,
  allCommands,
  onSave,
  onClose,
  onResetToDefault,
}: KeybindingCaptureModalProps) {
  // null = 还没捕获到完整组合(显示 currentHotkey 占位)
  // ''  = 显式 unbind(用户按了 Backspace)
  // string non-empty = 新组合
  const [captured, setCaptured] = useState<string | null>(null);

  // 每次打开都复位,避免旧值留下来
  useEffect(() => {
    if (visible) setCaptured(null);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 让 Modal 自己的 Esc 关闭逻辑接(我们传 onClose 给 Modal)
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        setCaptured('');
        return;
      }
      const combo = eventToCombo(e);
      if (combo !== null) {
        e.preventDefault();
        e.stopPropagation();
        setCaptured(combo);
      }
    };
    // capture 阶段拦截,避免 useCommandHotkeys 抢先 dispatch
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [visible]);

  const display = captured ?? currentHotkey ?? '';
  const isUnbind = captured === '';
  const hasPending = captured !== null;

  // 冲突检测:只在用户已捕获新组合(captured 非空)时检查;扫描其它命令的
  // effective hotkey 与新组合相同的(VSCode 同款 — 允许保存,只显示警告)
  const conflicts = useMemo(() => {
    if (!captured) return []; // null 或 unbind 都不冲突
    return allCommands.filter(
      (c) => c.id !== commandId && getEffectiveHotkey(c) === captured,
    );
  }, [captured, allCommands, commandId]);

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      className="w-[420px] p-5"
    >
      <h2 className="text-sm font-medium text-fg">设置快捷键</h2>
      <div className="mt-1 text-xs text-fg-muted">
        命令:<span className="text-fg">{commandTitle}</span>
      </div>

      <div className="mt-4 flex min-h-[60px] items-center justify-center rounded border border-line bg-panel-soft/50 p-4">
        {isUnbind ? (
          <span className="text-xs text-fg-dim">未绑定(unbound)</span>
        ) : display ? (
          <span className="flex items-center gap-1">
            {formatHotkeyParts(display, PLATFORM).map((p, i) => (
              <KeyCap key={`${p}-${i}`}>{p}</KeyCap>
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-dim">按下新组合…</span>
        )}
      </div>

      <div className="mt-2 text-[10px] text-fg-dim">
        按下新组合保存;<KeyCap>Backspace</KeyCap> 清空;
        <KeyCap>Esc</KeyCap> 取消
        {defaultHotkey && (
          <>
            ;默认 {formatHotkeyParts(defaultHotkey, PLATFORM).join(' ')}
          </>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-300">
          <div className="font-medium">⚠️ 此组合已绑定到其它命令</div>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {conflicts.map((c) => (
              <li key={c.id}>
                {c.title}{' '}
                <code className="text-[10px] text-amber-300/70">{c.id}</code>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-amber-300/80">
            保存后两个命令都会响应,建议先在原命令上 unbind 再保存这里。
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!defaultHotkey && captured !== ''}
          onClick={() => {
            onResetToDefault();
            onClose();
          }}
        >
          重置默认
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!hasPending}
          onClick={() => {
            if (captured === null) return;
            onSave(captured);
            onClose();
          }}
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}
