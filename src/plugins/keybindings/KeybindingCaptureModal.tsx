// 用户改快捷键的按键捕获 modal(M-Settings v6.5)。
// 监听全局 keydown,实时把组合呈现成 'mod+shift+x' 形式;Esc=取消,
// Backspace=清空(用户可保存空 = unbind),其它键 = 当前组合。

import { useEffect, useMemo, useState } from 'react';
import { Button, KeyCap, Modal } from '@/design';
import {
  formatHotkeyParts,
  detectPlatform,
  type Platform,
} from '@/plugins/command-palette/format-hotkey';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useT } from '@/i18n';
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

/** 把 keyboard event 编成 'mod+shift+x' 形式. 单独修饰键 → null(等用户继续按).
 *  平台感知,与 matchesHotkey(R15)对称:mac 上 metaKey=主修饰键存 'mod'、ctrlKey 存 'ctrl';
 *  非 mac 上 ctrlKey=主修饰键存 'mod'、metaKey 存 'cmd'。否则塌缩成 'mod' 会让 mac 用户按
 *  Ctrl+K 存成 mod+k,而 R15 后 mod+k 只匹配 Cmd+K → 用户刚按的 Ctrl 绑定失效、冲突检测也
 *  拿错组合比对。(codex 复审 loop R16,R15 捕获侧兄弟) */
export function eventToCombo(
  e: KeyboardEvent,
  platform: Platform = PLATFORM,
): string | null {
  const key = e.key;
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') {
    return null;
  }
  const parts: string[] = [];
  if (platform === 'mac') {
    if (e.metaKey) parts.push('mod');
    if (e.ctrlKey) parts.push('ctrl');
  } else {
    if (e.ctrlKey) parts.push('mod');
    if (e.metaKey) parts.push('cmd');
  }
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
  const t = useT();
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
      <h2 className="text-sm font-medium text-fg">{t('keybindings.modal.title')}</h2>
      <div className="mt-1 text-xs text-fg-muted">
        {t('keybindings.modal.command_label')}<span className="text-fg">{commandTitle}</span>
      </div>

      <div className="mt-4 flex min-h-[60px] items-center justify-center rounded border border-line bg-panel-soft/50 p-4">
        {isUnbind ? (
          <span className="text-xs text-fg-dim">{t('keybindings.modal.unbound')}</span>
        ) : display ? (
          <span className="flex items-center gap-1">
            {formatHotkeyParts(display, PLATFORM).map((p) => (
              <KeyCap key={p}>{p}</KeyCap>
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-dim">{t('keybindings.modal.press_combo')}</span>
        )}
      </div>

      <div className="mt-2 text-2xs text-fg-dim">
        {t('keybindings.modal.hint_press_save')}<KeyCap>Backspace</KeyCap> {t('keybindings.modal.hint_clear')}
        <KeyCap>Esc</KeyCap> {t('keybindings.modal.hint_cancel')}
        {defaultHotkey && (
          <>{t('keybindings.modal.hint_default', { hotkey: formatHotkeyParts(defaultHotkey, PLATFORM).join(' ') })}</>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
          <div className="font-medium">{t('keybindings.modal.conflict_title')}</div>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {conflicts.map((c) => (
              <li key={c.id}>
                {c.title}{' '}
                <code className="text-2xs text-warning/70">{c.id}</code>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-warning/80">
            {t('keybindings.modal.conflict_advice')}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
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
          {t('keybindings.modal.reset_default')}
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
          {t('common.save')}
        </Button>
      </div>
    </Modal>
  );
}
