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
import {
  HOTKEY_SHAPE_RE,
  type CommandSpec,
} from '@/plugins/registries/CommandRegistry';
import { useT } from '@/i18n';
import { getEffectiveHotkey } from './keybindings-store';

const PLATFORM = detectPlatform();
const EMPTY_CONFLICTS: readonly CommandSpec[] = [];

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
  const parts = new Array<string>(5);
  let partCount = 0;
  if (platform === 'mac') {
    if (e.metaKey) parts[partCount++] = 'mod';
    if (e.ctrlKey) parts[partCount++] = 'ctrl';
  } else {
    if (e.ctrlKey) parts[partCount++] = 'mod';
    if (e.metaKey) parts[partCount++] = 'cmd';
  }
  if (e.shiftKey) parts[partCount++] = 'shift';
  if (e.altKey) parts[partCount++] = 'alt';
  parts[partCount++] = key.toLowerCase();
  parts.length = partCount;
  const combo = parts.join('+');
  // 边界(E145):只产出注册侧 HOTKEY_SHAPE_RE 接受的合法形态。Space(e.key === ' ')→ 含空白、
  // 主键为 '+'(→ 'shift++' 空段)等会被 compileCombo trim/split 成空主键 → 永远不触发 + 显示异常。
  // 这类无法表示的组合直接拒绝(返 null,不捕获),与注册/写端校验一致。
  return HOTKEY_SHAPE_RE.test(combo) ? combo : null;
}

export function selectKeybindingConflicts(
  allCommands: readonly CommandSpec[],
  commandId: string,
  captured: string | null,
): readonly CommandSpec[] {
  if (!captured) return EMPTY_CONFLICTS;
  let conflictCount = 0;
  for (const command of allCommands) {
    if (command.id === commandId || getEffectiveHotkey(command) !== captured) {
      continue;
    }
    conflictCount += 1;
  }
  if (conflictCount === 0) return EMPTY_CONFLICTS;
  const conflicts = new Array<CommandSpec>(conflictCount);
  let index = 0;
  for (const command of allCommands) {
    if (command.id === commandId || getEffectiveHotkey(command) !== captured) {
      continue;
    }
    conflicts[index] = command;
    index += 1;
  }
  return conflicts;
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
      if (e.key === 'Tab') {
        // a11y(A62):不拦截 Tab。否则 eventToCombo 会把 Tab(含 Shift+Tab)当成组合捕获并
        // preventDefault → 弹窗内键盘用户无法在 取消/重置/保存 间移动焦点(捕获组合后 Save
        // 启用却到达不了),形成键盘陷阱。放行让 Modal focus trap / 浏览器默认 Tab 处理焦点移动。
        return;
      }
      // a11y(A63,A62 同族):焦点已能 Tab 到 取消/重置/保存(A62)后,若仍把 Enter/Space 当组合
      // 捕获并 preventDefault,键盘用户无法激活聚焦的按钮 → 键盘断点仍在。当事件目标位于原生
      // 交互控件(按钮/链接/输入等)内且是「无修饰」激活键(Enter/Space)时放行,让控件激活;
      // 带 ctrl/meta/alt 的 Enter(如 mod+enter)按钮不会激活,仍按组合捕获,不影响绑定能力。
      const isActivationKey = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
      const hasComboModifier = e.metaKey || e.ctrlKey || e.altKey;
      if (isActivationKey && !hasComboModifier) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a[href], input, select, textarea, [role="button"]')) {
          return;
        }
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
    return selectKeybindingConflicts(allCommands, commandId, captured);
  }, [captured, allCommands, commandId]);

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      className="w-[420px] p-5"
      aria-labelledby="keybinding-capture-title"
    >
      {/* a11y(A13):dialog 关联标题。 */}
      <h2 id="keybinding-capture-title" className="text-sm font-medium text-fg">{t('keybindings.modal.title')}</h2>
      <div className="mt-1 text-xs text-fg-muted">
        {t('keybindings.modal.command_label')}<span className="text-fg">{commandTitle}</span>
      </div>

      {/* a11y(A61,A52 同族:捕获结果框本身):按键由 document capture 处理,焦点不在此框上,
          框内容随每次按键在「按下新组合」/组合键/「未绑定」间动态切换。无 live region 时 AT
          用户按下组合后听不到是否已捕获/清空,只能盲目保存。捕获结果是中性进度 → role=status
          (polite,不打断);A52 修的是冲突警告(下方),这是捕获结果框本身。 */}
      <div
        role="status"
        className="mt-4 flex min-h-[60px] items-center justify-center rounded border border-line bg-panel-soft/50 p-4"
      >
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
        // a11y(A52,A41 同族):捕获后动态出现的冲突警告须 live region,否则焦点在弹窗内的 AT
        // 用户听不到冲突、可能保存一个已冲突的快捷键。冲突是可覆盖的警告 → polite(role=status)。
        <div
          role="status"
          className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning"
        >
          <div className="font-medium">
            {/* a11y(A89,A84 同族):conflict_title catalog 已去 ⚠️,视觉警告 emoji 在 JSX 用
                aria-hidden 单独渲染,不混进 role=status 播报。 */}
            <span aria-hidden="true">⚠️</span> {t('keybindings.modal.conflict_title')}
          </div>
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
