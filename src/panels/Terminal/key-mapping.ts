// Continuo terminal 键位映射(extra layer on top of xterm 默认按键).
//
// xterm.js 默认 Enter / Shift+Enter 都发 \r,Claude Code / Codex 等 ink-based
// CLI 在 \r 上一律提交输入,无法在输入框内换行。本模块在 xterm
// attachCustomKeyEventHandler 里拦截 Shift+Enter,改写成 ESC+CR(\x1b\r),
// 这是 Alt+Enter / Meta+Enter 的转义前缀约定:
//   - Claude Code / Codex / ink-based CLI:识别 ESC 前缀 → 输入框内换行
//   - 普通 shell readline (bash/zsh/fish):ESC+CR 默认绑定 accept-line,行为
//     等同 Enter,不会破坏正常 shell 体验
// 见 issue #18。

/**
 * 把 xterm 收到的 KeyboardEvent 映射成要写到 PTY 的字节序列。
 * 返回 null 时调用方应让 xterm 走默认处理。
 */
export function mapTerminalKey(event: KeyboardEvent): string | null {
  if (event.isComposing) return null;
  if (
    event.type === 'keydown' &&
    event.key === 'Enter' &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    return '\x1b\r';
  }
  return null;
}

/**
 * Shift+Enter 等键映射在 PTY 字节流中的暂存状态。
 * 由 customKeyEventHandler 设置,由 term.onData 转发器消费。
 * 见 issue #18 H1(双写)修法。
 */
export interface MappedKeyState {
  pending: string | null;
}

export function createMappedKeyState(): MappedKeyState {
  return { pending: null };
}

/**
 * 在 xterm customKeyEventHandler 中调用。若 mapTerminalKey 命中,把映射字节
 * 存进 state.pending,等待 onData 转发器替换。必须 return true 让 xterm 走
 * 默认(否则 onData 不触发,pending 无法被消费)。
 */
export function applyMappedKeyOnKeydown(
  state: MappedKeyState,
  event: KeyboardEvent,
): void {
  const mapped = mapTerminalKey(event);
  if (mapped !== null) {
    state.pending = mapped;
  }
}

/**
 * 在 term.onData 转发器中调用。若 state.pending 非空,用 pending 替换 data
 * 并清 pending;否则原样返回。这是 H1 双写的核心修法:Shift+Enter 时 xterm
 * 自己发 \r 到 onData,此函数把它替换为 \x1b\r,所以 PTY 只看到一份 \x1b\r。
 */
export function consumeMappedKeyOnData(
  state: MappedKeyState,
  data: string,
): string {
  if (state.pending !== null) {
    const result = state.pending;
    state.pending = null;
    return result;
  }
  return data;
}
