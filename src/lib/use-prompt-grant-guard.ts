// 授权类弹窗的防误触守卫(agent 授权弹窗 AgentAuthPrompt 与插件权限弹窗 PermissionPrompt 共用)。
//
// 这类弹窗的出现时机由对方(agent / 插件)决定,且会抢走键盘焦点:用户正在终端 / 编辑器打字或点击时,落进弹窗的
// 按键 / 连点不能变成授予。插件权限弹窗只对授予方向设防(拒绝与 Esc 直接放行,初始焦点在拒绝按钮);agent 授权弹窗
// 连拒绝方向也设防(被拒会进冷却,误拒让 agent 数十秒到数分钟拿不到授权):拒绝按钮同样标 PROMPT_GRANT_BUTTON_PROPS、
// 先问 canGrant,Esc / 点遮罩先问 canDismiss,初始焦点放在对话框容器上(Modal 容器 data-autofocus)。
// 防误触是授权弹窗的业务规则,不放进通用的 design Modal。
//
// 授予按钮的用法:标上 PROMPT_GRANT_BUTTON_PROPS,onClick 里先问 guard.canGrant(e)。
// 弹窗里其它「授予方向」的状态变更(勾上权限、全选)同样先问 guard.canGrant。
// 被拒掉的激活要让用户感知得到:弹窗里放一个 <PromptGrantHint guard={guard} />(lib/prompt-grant-hint)。

import { useLayoutEffect, useRef, useState } from 'react';
import { FOCUSABLE_SELECTOR } from '@/design/Modal';

/**
 * 防误触的时间窗:弹窗出现 / 内容切换后忽略授予方向激活的时长(覆盖一次双击的间隔);也是键盘激活授予按钮前
 * 要求的聚焦时长与按键前的停顿时长。
 */
export const PROMPT_GRANT_ARM_DELAY_MS = 500;

/** 被拒提示的显示时长(之后清空,下一次被拒时读屏会重新播报)。 */
export const PROMPT_GRANT_HINT_MS = 4000;

/** 授予方向的按钮都要带上(守卫靠它认出自己负责的弹窗)。 */
export const PROMPT_GRANT_BUTTON_PROPS = { 'data-prompt-grant': '' } as const;
const GRANT_BUTTON_SELECTOR = '[data-prompt-grant]';


/** click 事件里守卫用到的部分(React.MouseEvent 满足)。 */
export interface GrantClick {
  /** 浏览器约定:指针点击 ≥ 1(连击的第 n 击为 n);键盘(Enter / Space)与程序触发的 click 为 0。 */
  readonly detail: number;
  readonly currentTarget: Element;
}

export interface PromptGrantGuard {
  /**
   * 这次对授予按钮(或别的授予方向控件)的 click 是否算数。
   * - 任何方式:当前请求**出现**(首次出现或由别的请求切换而来)后 PROMPT_GRANT_ARM_DELAY_MS 内无效;在此期间
   *   被拒掉的激活把计时起点推到它自己的时刻(过早的点击之后要再等满一个时间窗)。
   * - 指针点击只认单击(detail=1):双击 / 多击的后几击不算(第一击被拒、第二击跨过时间窗不能落成授予)。
   * - 键盘激活另须是停顿后的有意按键:该按钮已持续聚焦 ≥ PROMPT_GRANT_ARM_DELAY_MS、聚焦期间没有打过字、这一下
   *   按键不是键重复且之前 PROMPT_GRANT_ARM_DELAY_MS 内没有别的按键。出现延迟挡不住「晚到」的按键:用户没注意到
   *   弹窗,继续原来的输入流(Tab 补全后回车、切模式后打一句话再回车),其中的 Space / Enter 不能落成授予。
   * - 焦点若是被「输入流里的 Tab」带到按钮上的(那一下 Tab 紧跟在别的按键后、或在请求出现后
   *   PROMPT_GRANT_ARM_DELAY_MS 内按下、或请求出现后打过字),这次聚焦期间键盘激活一律无效 —— Tab 之后停下来
   *   看一眼补全再回车,聚焦时长与按键前停顿都满足。把焦点移开、停顿后再 Tab 回来(或用鼠标)才可用。
   * - 被拒掉的**指针**点击不能留下可用键盘授予的焦点(过早的单击 / 双击把焦点带到授予按钮上,停顿后的 Enter 各项
   *   键盘条件都满足):①指针点击会被拒的时刻(出现时间窗内、多击的后几击),弹窗里的 mousedown / pointerdown
   *   被 preventDefault,焦点不随按下移入;②点击被拒时焦点若已在该控件上,这次聚焦标为不可键盘授予,并把焦点
   *   移回弹窗的初始焦点(插件权限弹窗:拒绝按钮;agent 授权弹窗:对话框容器)。
   */
  readonly canGrant: (e: GrantClick) => boolean;
  /**
   * 当前请求若是由另一个显示中的请求**直接切换**而来(不经空闲),切换后 PROMPT_GRANT_ARM_DELAY_MS 内为 false。
   * 给「对旧弹窗的连点 / 键重复不能落到新请求上」的场景用(连拒绝方向也挡);首次出现不受影响。
   */
  readonly switchSettled: () => boolean;
  /**
   * 不经按钮的拒绝方向收口(Esc / 点遮罩)是否算数:请求出现后 PROMPT_GRANT_ARM_DELAY_MS 内无效(被拒的同样把计时起点推后);
   * 由按键触发时,这一下须是停顿后的单次按键 —— 输入流里的 Esc(vim 里 `ihello<Esc>`、取消补全)不算。被拒同样给提示。
   */
  readonly canDismiss: () => boolean;
  /**
   * 最近一次 canGrant 是否把激活拒掉了(PROMPT_GRANT_HINT_MS 后、被接受的激活之后、请求切换后复位)。
   * useSyncExternalStore 形状,供 PromptGrantHint 订阅。
   */
  readonly subscribeRejected: (onChange: () => void) => () => void;
  readonly wasRejected: () => boolean;
}

interface GuardState {
  last: unknown;
  shownAt: number | null;
  /** 授予方向的计时起点:出现时刻,被出现延迟拒掉的激活会把它推后。 */
  armAt: number | null;
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
  /** 最近一次 keydown 是否「输入流里的 Tab」。 */
  keyIsStreamTab: boolean;
  /**
   * 当前这次聚焦不可用键盘授予:焦点由输入流里的 Tab 带来,或是被拒掉的指针点击留下的。焦点移开再回来才重置。
   */
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
    armAt: null,
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
  const [feedback] = useState(createRejectionFeedback);
  // layout effect:在浏览器处理下一次输入之前就记下出现时刻。
  useLayoutEffect(() => {
    const s = state.current;
    if (Object.is(current, s.last)) return;
    const now = Date.now();
    s.switchedAt = current !== null && s.last !== null ? now : null;
    s.shownAt = s.armAt = current !== null ? now : null;
    s.typedSinceShown = false;
    s.last = current;
    feedback.set(false);
  }, [current, feedback]);

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
        // Modal 的焦点陷阱会让第一个元素(拒绝)/ 对话框容器(初始焦点)上的 Shift+Tab 回绕到最后一个元素(权限最大的
        // 授予按钮)。拦下:焦点留在原处;向前 Tab 仍可到达所有元素。
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
    // 指针按下(鼠标 / 触摸 / 笔)会把焦点移到被按的控件上。这一下点击若注定被拒(出现时间窗内、多击的后几击),
    // 不让焦点移入:否则被拒之后停顿片刻的 Enter / Space 满足全部键盘条件,落成授予。只取消按下的默认动作
    //(聚焦、选中文本),click 照常派发(仍由 canGrant 拒掉并给提示);之后的正常点击不受影响。
    // pointerdown 也拦:Chromium 里它被取消后不再派发兼容的 mousedown,聚焦同样不发生。
    const onPointerDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Element) || grantDialogOf(e.target) === null) return;
      const early = s.armAt === null || Date.now() - s.armAt < PROMPT_GRANT_ARM_DELAY_MS;
      if (early || e.detail > 1) e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      s.focusEl = null;
    };
  }, [active]);

  // 卸载时不留定时器。
  useLayoutEffect(() => () => feedback.set(false), [feedback]);

  const [guard] = useState<PromptGrantGuard>(() => {
    const decide = (e: GrantClick): boolean => {
      const s = state.current;
      const now = Date.now();
      // 出现时刻未知(尚未记录)→ 不可用。
      if (s.armAt === null) return false;
      if (now - s.armAt < PROMPT_GRANT_ARM_DELAY_MS) {
        s.armAt = now;
        return false;
      }
      if (e.detail > 0) return e.detail === 1;
      if (s.focusEl !== e.currentTarget || now - s.focusAt < PROMPT_GRANT_ARM_DELAY_MS) return false;
      if (s.typedWhileFocused || s.focusByStreamTab) return false;
      // 刚按下的键就是触发这次 click 的那一下:它须是停顿后的单次按键。更早的按键(或没有按键:辅助技术触发的
      // click)→ 已满足停顿。
      const keyIsRecent = s.keyAt !== null && now - s.keyAt < PROMPT_GRANT_ARM_DELAY_MS;
      return !keyIsRecent || s.keyDeliberate;
    };
    return {
      canGrant: (e) => {
        const ok = decide(e);
        // 被拒的指针点击:焦点若已在该控件上(按下时聚焦没拦住,或更早由别的途径聚焦),不留给之后的键盘激活。
        if (!ok && e.detail > 0) dropPointerFocus(state.current, e.currentTarget);
        feedback.set(!ok);
        return ok;
      },
      canDismiss: () => {
        const s = state.current;
        const now = Date.now();
        let ok = s.armAt !== null && now - s.armAt >= PROMPT_GRANT_ARM_DELAY_MS;
        if (!ok && s.armAt !== null) s.armAt = now;
        // 触发这次收口的按键刚刚按下(Esc;capture 阶段已记下):须是停顿后的单次按键。点遮罩 → 最近没有按键,只看出现延迟。
        if (ok && s.keyAt !== null && now - s.keyAt < PROMPT_GRANT_ARM_DELAY_MS) ok = s.keyDeliberate;
        feedback.set(!ok);
        return ok;
      },
      switchSettled: () => {
        const at = state.current.switchedAt;
        return at === null || Date.now() - at >= PROMPT_GRANT_ARM_DELAY_MS;
      },
      subscribeRejected: feedback.subscribe,
      wasRejected: feedback.get,
    };
  });
  return guard;
}

/** 「最近一次授予激活被拒」的小型外部 store:被拒后 PROMPT_GRANT_HINT_MS 自动复位。 */
function createRejectionFeedback(): {
  set(rejected: boolean): void;
  get(): boolean;
  subscribe(onChange: () => void): () => void;
} {
  let rejected = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: boolean): void => {
    if (timer !== null) clearTimeout(timer);
    timer = next ? setTimeout(() => set(false), PROMPT_GRANT_HINT_MS) : null;
    if (rejected === next) return;
    rejected = next;
    for (const listener of listeners) listener();
  };
  return {
    set,
    get: () => rejected,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
  };
}

/** el 所在的授权弹窗(含授予按钮的 dialog);不在其中 → null。 */
function grantDialogOf(el: Element | null | undefined): Element | null {
  const dialog = el?.closest('[role="dialog"]') ?? null;
  return dialog !== null && dialog.querySelector(GRANT_BUTTON_SELECTOR) !== null ? dialog : null;
}

function isFirstFocusableOfGrantDialog(el: Element | null): boolean {
  const dialog = grantDialogOf(el);
  return dialog !== null && (dialog === el || dialog.querySelector(FOCUSABLE_SELECTOR) === el);
}

/**
 * 被拒的指针点击落在已聚焦的控件上:这次聚焦标为不可键盘授予,并把焦点移回弹窗的初始焦点(与 design Modal 同一
 * 规则:容器自身带 [data-autofocus] → 容器(agent 授权弹窗);否则内部的 [data-autofocus],再否则第一个可聚焦元素
 *(插件权限弹窗的拒绝按钮))。移回而不是 blur:blur 后焦点落到
 * body,读屏丢失位置、焦点陷阱也要等下一次 Tab 才接管;移回拒绝按钮,读屏播报的是一个确定的、安全的位置,
 * 被拒的原因由 status 区域播报。找不到可移回的元素时焦点留在原处,靠标记挡住键盘授予。
 */
function dropPointerFocus(s: GuardState, control: Element): void {
  if (document.activeElement !== control) return;
  s.focusByStreamTab = true;
  const dialog = grantDialogOf(control);
  const home =
    dialog?.hasAttribute('data-autofocus') === true
      ? (dialog as HTMLElement)
      : (dialog?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
        dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR));
  if (home != null && home !== control && !home.matches(GRANT_BUTTON_SELECTOR)) home.focus();
}
