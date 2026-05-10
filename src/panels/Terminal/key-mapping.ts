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
