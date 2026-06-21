// 安全 S1(codex 安全审计):任意 file:// 弹窗/frame 曾被当受信并注入全量 preload →
// renderer 内代码(恶意插件)写 evil.html 再 window.open('file:///.../evil.html') 即可
// 拿全量 IPC(fs/shell/plugin raw)越权。修复:只信真实 renderer 入口 index.html 的
// file URL(精确 pathname),其它 file:// 一律拒。windowOpenHandler 与
// defaultIsTrustedFrame 共用 isTrustedRendererFileUrl。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  defaultIsTrustedFrame,
  isTrustedRendererFileUrl,
  setTrustedRendererFile,
  _resetTrustedRendererFileForTest,
} from '../../../electron/main/safe-handle';

const ENTRY = '/Applications/Continuo.app/Contents/Resources/app/out-pack/renderer/index.html';

beforeEach(() => {
  _resetTrustedRendererFileForTest();
});
afterEach(() => {
  _resetTrustedRendererFileForTest();
});

describe('安全 S1 — file:// 受信收紧', () => {
  it('未注册(单测/早期)→ 退回宽松:任意 file:// 受信(向后兼容)', () => {
    expect(isTrustedRendererFileUrl('file:///tmp/evil.html')).toBe(true);
    expect(defaultIsTrustedFrame({ url: 'file:///x/index.html' })).toBe(true);
  });

  it('注册后 → 只信真实 renderer 入口 pathname,query/hash 忽略', () => {
    setTrustedRendererFile(ENTRY);
    // 真实入口(含 query/hash)→ 受信
    expect(isTrustedRendererFileUrl(`file://${ENTRY}`)).toBe(true);
    expect(isTrustedRendererFileUrl(`file://${ENTRY}?windowSeq=1`)).toBe(true);
    expect(isTrustedRendererFileUrl(`file://${ENTRY}#/popout/panel`)).toBe(true);
  });

  it('注册后 → 攻击者的任意 file:// 一律拒(核心安全断言)', () => {
    setTrustedRendererFile(ENTRY);
    expect(isTrustedRendererFileUrl('file:///tmp/evil.html')).toBe(false);
    // 攻击者命名 index.html 但路径不同 → 仍拒
    expect(isTrustedRendererFileUrl('file:///tmp/index.html')).toBe(false);
    // 插件目录下任意 html → 拒
    expect(
      isTrustedRendererFileUrl('file:///Users/u/.continuo/plugins/evil/payload.html'),
    ).toBe(false);
  });

  it('注册后 → defaultIsTrustedFrame 同步收紧:非入口 file:// frame 不受信', () => {
    setTrustedRendererFile(ENTRY);
    expect(defaultIsTrustedFrame({ url: `file://${ENTRY}` })).toBe(true);
    expect(defaultIsTrustedFrame({ url: 'file:///tmp/evil.html' })).toBe(false);
    expect(defaultIsTrustedFrame({ url: 'file:///tmp/index.html' })).toBe(false);
  });

  it('非 file:// → 不被 file 分支误判(走 dev origin 检查)', () => {
    setTrustedRendererFile(ENTRY);
    expect(isTrustedRendererFileUrl('https://evil.com/index.html')).toBe(false);
    expect(defaultIsTrustedFrame({ url: 'https://evil.com/' })).toBe(false);
  });
});
