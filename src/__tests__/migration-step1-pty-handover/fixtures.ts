// 5 个 spec 复写的 BrowserWindow mock 工厂 — 集中到一处。
// 用于 migration-step1-pty-handover + migration-step2-buffer-merge。

import { vi } from 'vitest';
import type { BrowserWindow } from 'electron';

export function makeWindow(id: number, destroyed = false): BrowserWindow {
  const webContents = {
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
  };
  return {
    id,
    isDestroyed: vi.fn(() => destroyed),
    webContents,
  } as unknown as BrowserWindow;
}
