// 守卫漂移回归:js-debug 的 Node 线程 id 合法值含 0。MCP 侧 schema(mcp-debug-schemas threadIdSchema)
// 早已从 min(1) 改为 min(0),但 Debug 面板走的 debug-view IPC 孪生入口仍是 .positive() → threadId=0 的
// getStack 被 zod 判 BAD_INPUT,debug.store 静默吞掉 → 断点停住后调用栈为空。两入口须共用同一 schema。
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: { handle: vi.fn() }, app: {} }));

import { debugGetStackInputSchema } from '../../../electron/main/ipc/debug-view.ipc';
import { debugStackInputSchema } from '../../../electron/shared/mcp-debug-schemas';

describe('debug-view getStack 输入 schema', () => {
  it('threadId = 0 合法(与 MCP debug.stack 一致)', () => {
    expect(debugGetStackInputSchema.safeParse({ sessionId: 's1', threadId: 0 }).success).toBe(true);
    expect(debugStackInputSchema.safeParse({ session_id: 's1', thread_id: 0 }).success).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])('threadId = %s 非法', (threadId) => {
    expect(debugGetStackInputSchema.safeParse({ sessionId: 's1', threadId }).success).toBe(false);
  });

  it('sessionId 上限与 MCP 侧同源', () => {
    expect(debugGetStackInputSchema.safeParse({ sessionId: 'x'.repeat(256) }).success).toBe(true);
    expect(debugGetStackInputSchema.safeParse({ sessionId: 'x'.repeat(257) }).success).toBe(false);
    expect(debugGetStackInputSchema.safeParse({ sessionId: '' }).success).toBe(false);
  });
});
