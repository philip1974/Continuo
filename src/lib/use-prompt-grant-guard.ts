// 授权类弹窗的防误触守卫(agent 授权弹窗 AgentAuthPrompt 与插件权限弹窗 PermissionPrompt 共用)。
//
// 这类弹窗的出现时机由对方(agent / 插件)决定,且会抢走键盘焦点:用户正在终端 / 编辑器打字或点击时,落进弹窗的
// 按键(Tab+Enter)/ 连点不能变成授予。只对授予方向设防 —— 拒绝与 Esc 由调用方直接放行,初始焦点由调用方放在
// 拒绝按钮上。design Modal 是与 Nous 共享的副本,不在那一层加。

import { useLayoutEffect, useRef, useState } from 'react';

/** 弹窗出现 / 内容切换后,忽略授予方向激活(鼠标与键盘)的时长;覆盖一次双击的间隔。 */
export const PROMPT_GRANT_ARM_DELAY_MS = 500;

export interface PromptGrantGuard {
  /** 授予方向是否可用:当前请求**出现**(首次出现或由别的请求切换而来)后 PROMPT_GRANT_ARM_DELAY_MS 内为 false。 */
  readonly grantArmed: () => boolean;
  /**
   * 当前请求若是由另一个显示中的请求**直接切换**而来(不经空闲),切换后 PROMPT_GRANT_ARM_DELAY_MS 内为 false。
   * 给「对旧弹窗的连点 / 键重复不能落到新请求上」的场景用(连拒绝方向也挡);首次出现不受影响。
   */
  readonly switchSettled: () => boolean;
}

/**
 * @param current 当前显示的请求的身份(对象引用或 id,按 Object.is 比较);没有弹窗时传 null。
 * 须在弹窗空闲时也保持挂载的组件里调用(body 换类型 / remount 不丢状态)。返回的对象与两个函数引用稳定。
 */
export function usePromptGrantGuard(current: unknown): PromptGrantGuard {
  const state = useRef<{ last: unknown; shownAt: number | null; switchedAt: number | null }>({
    last: null,
    shownAt: null,
    switchedAt: null,
  });
  // layout effect:在浏览器处理下一次输入之前就记下出现时刻。
  useLayoutEffect(() => {
    const s = state.current;
    if (Object.is(current, s.last)) return;
    const now = Date.now();
    s.switchedAt = current !== null && s.last !== null ? now : null;
    s.shownAt = current !== null ? now : null;
    s.last = current;
  }, [current]);
  const [guard] = useState<PromptGrantGuard>(() => ({
    // 出现时刻未知(尚未记录)→ 不可用。
    grantArmed: () => {
      const at = state.current.shownAt;
      return at !== null && Date.now() - at >= PROMPT_GRANT_ARM_DELAY_MS;
    },
    switchSettled: () => {
      const at = state.current.switchedAt;
      return at === null || Date.now() - at >= PROMPT_GRANT_ARM_DELAY_MS;
    },
  }));
  return guard;
}
