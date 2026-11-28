// 屏幕录制模式(VSCode「开发人员: 切换屏幕录制模式」workbench.action.toggleScreencastMode)的状态:开关、按键浮层上的条目、
// 鼠标按下指示。开关只在内存里(VSCode 同:ToggleScreencastModeAction 的静态 disposable,重新加载 / 重启后关闭)。
// 浮层逻辑 Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md):
// src/vs/workbench/browser/actions/developerActions.ts ToggleScreencastModeAction —— 带修饰键的组合 / Backspace / Esc / 方向键 /
// 已满 20 条时先清空再追加;最后一次按键后 keyboardOverlayTimeout 毫秒清空(这里先淡出、下次按键时再清空,见 ScreencastOverlay)。
// 鼠标:按下处显示圆圈,按住移动时跟随,松开消失。BDD: src/__tests__/screencast-mode/

import { create } from 'zustand';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

export interface ScreencastPress {
  readonly id: number;
  /** 键位(快捷键页同一格式化:⇧⌘P / Ctrl+Shift+P)。 */
  readonly keys: string;
  /** 按键分发到的命令标题(当前界面语言);没有命令 → 只显示键位。 */
  readonly title?: string;
}

export interface ScreencastMouse {
  readonly doc: Document;
  readonly x: number;
  readonly y: number;
}

interface ScreencastState {
  readonly enabled: boolean;
  readonly presses: readonly ScreencastPress[];
  /** 浮层正显示(false = 已淡出;条目保留到下一次按键,淡出动画里仍看得到)。 */
  readonly visible: boolean;
  /** 浮层画在哪个窗口(最近一次按键所在的主窗 / popout 子窗)。 */
  readonly doc: Document | null;
  readonly mouse: ScreencastMouse | null;
}

const INITIAL: Omit<ScreencastState, 'enabled'> = { presses: [], visible: false, doc: null, mouse: null };

export const useScreencastStore = create<ScreencastState>(() => ({ enabled: false, ...INITIAL }));

/** VSCode:超过 20 条清空重来。 */
const MAX_PRESSES = 20;
let nextId = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
}

export function toggleScreencastMode(): void {
  clearHideTimer();
  useScreencastStore.setState((s) => ({ enabled: !s.enabled, ...INITIAL }));
}

/**
 * 记一次按键:`restart` = 先清空(带修饰键的组合、Backspace / Esc / 方向键;VSCode 同);浮层已淡出时同样从空开始。
 * timeoutMs 后淡出。
 */
export function recordScreencastPress(
  press: Omit<ScreencastPress, 'id'>,
  restart: boolean,
  doc: Document,
  timeoutMs: number,
): void {
  const s = useScreencastStore.getState();
  if (!s.enabled) return;
  const kept = !s.visible || restart || s.presses.length > MAX_PRESSES ? [] : s.presses;
  useScreencastStore.setState({ presses: [...kept, { ...press, id: ++nextId }], visible: true, doc });
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    useScreencastStore.setState({ visible: false });
  }, timeoutMs);
}

export function setScreencastMouse(mouse: ScreencastMouse | null): void {
  if (!useScreencastStore.getState().enabled) return;
  useScreencastStore.setState({ mouse });
}

/** 命令 spec(WindowPlugin 注册;分类「开发人员」,无默认键 —— VSCode 同)。 */
export function screencastCommandSpec(): CommandSpec {
  return {
    id: 'workbench.action.toggleScreencastMode',
    title: 'Toggle Screencast Mode',
    titleKey: 'commands.developer.toggle_screencast_mode.title',
    category: 'Developer',
    categoryKey: 'commands.developer.category',
    fn: toggleScreencastMode,
  };
}
