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
 * 命中 Shift+(Cmd|Ctrl)+Enter 时返回 true,告诉 customKeyEventHandler 跳过 xterm
 * 默认处理(return false),让 document keydown 派发到 useCommandHotkeys 命令系统。
 *
 * 不读 isTrusted,纯函数形态便于 jsdom 测试。topic-22 zoom toggle 用。
 */
export function shouldSkipXtermKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  if (event.isComposing) return false;
  if (event.key !== 'Enter') return false;
  if (!event.shiftKey) return false;
  if (event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return true;
}

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
 * 在 term.onData 转发器中调用。若 state.pending 非空 AND data 是 Shift+Enter
 * 对应的 '\r',用 pending 替换并清 pending;否则原样返回。
 *
 * 关键 invariant(issue #36 F1 paste-stuck 修法):**任何 onData 都清 pending**,
 * 即使 data 不是 '\r' — 防 stale pending 在 Shift+Enter keydown 之后 / 配对
 * onData 之前的窗口期内 hijack 别的 input(eg paste)。pending 是 single-shot
 * single-data-shape contract(只对配对 '\r' 有效);任何其他 onData(paste / 字符 /
 * special sequence)都表示 pending 已 stale,清除是正确语义。
 *
 * Bug 复现路径(issue #36):
 *   1. Shift+Enter keydown → applyMappedKeyOnKeydown sets pending='\x1b\r'
 *   2. 某 reason onData('\r') 没及时 fire(focus / xterm 内部 race / paste preempt)
 *   3. User paste long text → onData('\x1b[200~text\x1b[201~')
 *   4. **旧逻辑**:pending 非空 → hijack 整段 paste data,替换为 '\x1b\r' →
 *      bracketed paste end sequence 丢失 → zsh 卡在 paste 状态,panel 全死
 *   5. **新逻辑**:data 不是 '\r' → pending 清除 + paste data 透传 → zsh 正常 receive
 */
export function consumeMappedKeyOnData(
  state: MappedKeyState,
  data: string,
): string {
  const pending = state.pending;
  // ALWAYS clear pending — single-shot contract, any subsequent onData
  // (paired '\r' or stale-window arrival) consumes the slot.
  state.pending = null;
  if (pending !== null && data === '\r') {
    // Shift+Enter mapped path:xterm 发 '\r' to onData;替换为 ESC+CR(\x1b\r)
    return pending;
  }
  return data;
}
