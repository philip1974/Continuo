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

  // 边界(E196 同族,isPopoutUrl 主进程对偶):defaultIsTrustedFrame/isTrustedRendererFileUrl 在每次 IPC
  // 调用对 frame.url 做 new URL(O(N))。超长 frame.url fail-closed 视为不受信(绝不进 new URL 解析)。
  describe('E196 同族 · frame.url 长度上限(每 IPC 热路径,fail-closed)', () => {
    it('未注册:超长 file:// → isTrustedRendererFileUrl false(不解析,不再宽松放行)', () => {
      const huge = `file:///tmp/${'a'.repeat(70000)}.html`;
      expect(huge.length).toBeGreaterThan(65536);
      expect(isTrustedRendererFileUrl(huge)).toBe(false);
    });

    it('注册后:超长入口前缀 file:// → defaultIsTrustedFrame false(fail-closed)', () => {
      setTrustedRendererFile(ENTRY);
      const huge = `file://${ENTRY}?pad=${'a'.repeat(70000)}`;
      expect(huge.length).toBeGreaterThan(65536);
      expect(defaultIsTrustedFrame({ url: huge })).toBe(false);
    });

    it('上限内正常入口 file:// → 仍受信(回归)', () => {
      setTrustedRendererFile(ENTRY);
      expect(defaultIsTrustedFrame({ url: `file://${ENTRY}` })).toBe(true);
    });
  });
});
