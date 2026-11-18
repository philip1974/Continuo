// 授权类弹窗的防误触守卫(agent 授权弹窗 AgentAuthPrompt 与插件权限弹窗 PermissionPrompt 共用)。
//
// 这类弹窗的出现时机由对方(agent / 插件)决定,且会抢走键盘焦点:用户正在终端 / 编辑器打字或点击时,落进弹窗的
// 按键 / 连点不能变成授予。只对授予方向设防 —— 拒绝与 Esc 由调用方直接放行,初始焦点由调用方放在拒绝按钮上。
// design Modal 是与 Nous 共享的副本,不在那一层加。
//
// 授予按钮的用法:标上 PROMPT_GRANT_BUTTON_PROPS,onClick 里先问 guard.canGrant(e)。

import { useLayoutEffect, useRef, useState } from 'react';

/**
 * 防误触的时间窗:弹窗出现 / 内容切换后忽略授予方向激活的时长(覆盖一次双击的间隔);也是键盘激活授予按钮前
 * 要求的聚焦时长与按键前的停顿时长。
 */
export const PROMPT_GRANT_ARM_DELAY_MS = 500;

/** 授予方向的按钮都要带上(守卫靠它认出自己负责的弹窗)。 */
export const PROMPT_GRANT_BUTTON_PROPS = { 'data-prompt-grant': '' } as const;
const GRANT_BUTTON_SELECTOR = '[data-prompt-grant]';

// 与 design Modal 焦点陷阱用的选择器一致(那边未导出)。
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** click 事件里守卫用到的部分(React.MouseEvent 满足)。 */
interface GrantClick {
  /** 浏览器约定:指针点击 ≥ 1;键盘(Enter / Space)与程序触发的 click 为 0。 */
  readonly detail: number;
  readonly currentTarget: Element;
}

export interface PromptGrantGuard {
  /**
   * 这次对授予按钮的 click 是否算数。
   * - 任何方式:当前请求**出现**(首次出现或由别的请求切换而来)后 PROMPT_GRANT_ARM_DELAY_MS 内无效。
   * - 键盘激活另须是停顿后的有意按键:该按钮已持续聚焦 ≥ PROMPT_GRANT_ARM_DELAY_MS、聚焦期间没有打过字、这一下
   *   按键不是键重复且之前 PROMPT_GRANT_ARM_DELAY_MS 内没有别的按键。出现延迟挡不住「晚到」的按键:用户没注意到
   *   弹窗,继续原来的输入流(Tab 补全后回车、切模式后打一句话再回车),其中的 Space / Enter 不能落成授予。
   * - 焦点若是被「输入流里的 Tab」带到按钮上的(那一下 Tab 紧跟在别的按键后、或在请求出现后
   *   PROMPT_GRANT_ARM_DELAY_MS 内按下、或请求出现后打过字),这次聚焦期间键盘激活一律无效 —— Tab 之后停下来
   *   看一眼补全再回车,聚焦时长与按键前停顿都满足。把焦点移开、停顿后再 Tab 回来(或用鼠标)才可用。
   */
  readonly canGrant: (e: GrantClick) => boolean;
  /**
   * 当前请求若是由另一个显示中的请求**直接切换**而来(不经空闲),切换后 PROMPT_GRANT_ARM_DELAY_MS 内为 false。
   * 给「对旧弹窗的连点 / 键重复不能落到新请求上」的场景用(连拒绝方向也挡);首次出现不受影响。
   */
  readonly switchSettled: () => boolean;
}

interface GuardState {
  last: unknown;
  shownAt: number | null;
  switchedAt: number | null;
  /** 最近一次 keydown 的时刻,以及它是否「停顿后的单次按键」(非键重复、之前一个时间窗内没有别的 keydown)。 */
  keyAt: number | null;
  keyDeliberate: boolean;
  /** 当前焦点元素、聚焦时刻、聚焦期间是否打过字(打字说明用户以为焦点还在原来的输入处)。 */
  focusEl: EventTarget | null;
  focusAt: number;
  typedWhileFocused: boolean;
  /** 当前请求出现后是否打过字。 */
  typedSinceShown: boolean;
  /** 最近一次 keydown 是否「输入流里的 Tab」;当前焦点是否由这样的 Tab 带来。 */
  keyIsStreamTab: boolean;
  focusByStreamTab: boolean;
}

/**
 * @param current 当前显示的请求的身份(对象引用或 id,按 Object.is 比较);没有弹窗时传 null。
 * 须在弹窗空闲时也保持挂载的组件里调用(body 换类型 / remount 不丢状态)。返回的对象与其函数引用稳定。
 */
export function usePromptGrantGuard(current: unknown): PromptGrantGuard {
  const state = useRef<GuardState>({
    last: null,
    shownAt: null,
    switchedAt: null,
    keyAt: null,
    keyDeliberate: false,
    focusEl: null,
    focusAt: 0,
    typedWhileFocused: false,
    typedSinceShown: false,
    keyIsStreamTab: false,
    focusByStreamTab: false,
  });
  // layout effect:在浏览器处理下一次输入之前就记下出现时刻。
  useLayoutEffect(() => {
    const s = state.current;
    if (Object.is(current, s.last)) return;
    const now = Date.now();
    s.switchedAt = current !== null && s.last !== null ? now : null;
    s.shownAt = current !== null ? now : null;
    s.typedSinceShown = false;
    s.last = current;
  }, [current]);

  // 有弹窗期间记录按键与焦点(capture 阶段:先于 Modal 的 keydown 处理与按钮自身的 click)。
  const active = current !== null;
  useLayoutEffect(() => {
    if (!active) return undefined;
    const s = state.current;
    const onKeyDown = (e: KeyboardEvent): void => {
      const now = Date.now();
      s.keyDeliberate =
        !e.repeat && (s.keyAt === null || now - s.keyAt >= PROMPT_GRANT_ARM_DELAY_MS);
      s.keyAt = now;
      // 可打印字符(Space 是按钮的激活键,不算):用户在打字。
      if (e.key.length === 1 && e.key !== ' ') s.typedWhileFocused = s.typedSinceShown = true;
      // 有意的 Tab:停顿后的单次按键、请求已出现一个时间窗、出现后没打过字。其余 Tab 都算输入流(补全)。
      s.keyIsStreamTab =
        e.key === 'Tab' &&
        !(
          s.keyDeliberate &&
          !s.typedSinceShown &&
          s.shownAt !== null &&
          now - s.shownAt >= PROMPT_GRANT_ARM_DELAY_MS
        );
      if (e.key === 'Tab' && e.shiftKey && isFirstFocusableOfGrantDialog(document.activeElement)) {
        // Modal 的焦点陷阱会让第一个元素(拒绝)上的 Shift+Tab 回绕到最后一个元素(权限最大的授予按钮)。
        // 拦下:焦点留在原处;向前 Tab 仍可到达所有元素。
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFocusIn = (e: FocusEvent): void => {
      s.focusEl = e.target;
      s.focusAt = Date.now();
      s.typedWhileFocused = false;
      // Tab 的焦点移动紧跟在它的 keydown 之后。
      s.focusByStreamTab =
        s.keyIsStreamTab && s.keyAt !== null && s.focusAt - s.keyAt < PROMPT_GRANT_ARM_DELAY_MS;
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      s.focusEl = null;
    };
  }, [active]);

  const [guard] = useState<PromptGrantGuard>(() => ({
    canGrant: (e) => {
      const s = state.current;
      const now = Date.now();
      // 出现时刻未知(尚未记录)→ 不可用。
      if (s.shownAt === null || now - s.shownAt < PROMPT_GRANT_ARM_DELAY_MS) return false;
      if (e.detail > 0) return true;
      if (s.focusEl !== e.currentTarget || now - s.focusAt < PROMPT_GRANT_ARM_DELAY_MS) return false;
      if (s.typedWhileFocused || s.focusByStreamTab) return false;
      // 刚按下的键就是触发这次 click 的那一下:它须是停顿后的单次按键。更早的按键(或没有按键:辅助技术触发的
      // click)→ 已满足停顿。
      const keyIsRecent = s.keyAt !== null && now - s.keyAt < PROMPT_GRANT_ARM_DELAY_MS;
      return !keyIsRecent || s.keyDeliberate;
    },
    switchSettled: () => {
      const at = state.current.switchedAt;
      return at === null || Date.now() - at >= PROMPT_GRANT_ARM_DELAY_MS;
    },
  }));
  return guard;
}

function isFirstFocusableOfGrantDialog(el: Element | null): boolean {
  const dialog = el?.closest('[role="dialog"]');
  if (!dialog || dialog.querySelector(GRANT_BUTTON_SELECTOR) === null) return false;
  return dialog.querySelector(FOCUSABLE_SELECTOR) === el;
}
