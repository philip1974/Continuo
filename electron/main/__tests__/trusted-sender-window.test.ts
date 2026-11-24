// trustedSenderWindow:单向 IPC(就绪握手 / 回执 / 脏态上报)的发送方窗口 —— 受信 frame,且发送方正是该窗口自己的主
// webContents(子 webContents 的上报不得记到宿主窗口)。index.ts 的 on 入口共用。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ windowOf: new Map<object, unknown>() }));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (wc: object) => electron.windowOf.get(wc) ?? null },
}));

import {
  _resetTrustedRendererFileForTest,
  setTrustedRendererFile,
  trustedSenderWindow,
} from '../safe-handle';

const ENTRY = path.resolve('/app/out/renderer/index.html');
const trustedFrame = { url: pathToFileURL(ENTRY).href };

beforeEach(() => {
  _resetTrustedRendererFileForTest();
  setTrustedRendererFile(ENTRY);
});
afterEach(() => {
  _resetTrustedRendererFileForTest();
  electron.windowOf.clear();
});

describe('trustedSenderWindow', () => {
  it('受信 frame + 发送方是窗口主 webContents → 该窗口', () => {
    const sender = {};
    const win = { id: 3, isDestroyed: () => false, webContents: sender };
    electron.windowOf.set(sender, win);
    expect(trustedSenderWindow({ sender, senderFrame: trustedFrame } as never)).toBe(win);
  });

  it('子 webContents(不是窗口主 webContents)/ 窗口已销毁 / 无窗口 / 不受信 frame → null', () => {
    const main = {};
    const child = {};
    const win = { id: 3, isDestroyed: () => false, webContents: main };
    electron.windowOf.set(child, win);
    expect(trustedSenderWindow({ sender: child, senderFrame: trustedFrame } as never)).toBeNull();

    const dead = {};
    electron.windowOf.set(dead, { id: 4, isDestroyed: () => true, webContents: dead });
    expect(trustedSenderWindow({ sender: dead, senderFrame: trustedFrame } as never)).toBeNull();

    expect(trustedSenderWindow({ sender: {}, senderFrame: trustedFrame } as never)).toBeNull();

    electron.windowOf.set(main, win);
    expect(
      trustedSenderWindow({ sender: main, senderFrame: { url: 'https://evil.example/' } } as never),
    ).toBeNull();
  });
});
