// wc-gone-hook 只把「主框架、非同文档、浏览器侧发起、目标为本应用 renderer 入口」的导航视为 reload。
// Electron 先发 did-start-navigation 再发 will-frame-navigate:导航守卫(installNavigationGuard)在
// will-frame-navigate 里 preventDefault 拦下页面发起的导航(location.reload / <a href> 点击 / 拖入 URL)时,
// did-start-navigation 已经发生、文档却未被替换。若此时就释放资源,fs watcher / 插件身份 token / 插件 MCP 工具 / 插件子进程会被误回收,旧页面
// 仍在用却收不到任何通知(Explorer 不再刷新、插件 fs 全部失败)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeWcGoneHook,
  setPageReloadPredicate,
  setReloadUrlPredicate,
} from '../../../electron/main/lib/wc-gone-hook';

type Listener = (...args: unknown[]) => void;

function fakeWc(id: number, currentUrl = 'app://renderer/index.html') {
  const on = new Map<string, Listener[]>();
  return {
    id,
    getURL: () => currentUrl,
    once: (ev: string, fn: Listener) => on.set(ev, [...(on.get(ev) ?? []), fn]),
    on: (ev: string, fn: Listener) => on.set(ev, [...(on.get(ev) ?? []), fn]),
    emit: (ev: string, ...args: unknown[]) => (on.get(ev) ?? []).forEach((fn) => fn(...args)),
  };
}

afterEach(() => {
  setReloadUrlPredicate(null);
  setPageReloadPredicate(null);
});

describe('wc-gone-hook · 被拦下的外链导航不算 reload', () => {
  it('注入 reload URL 判定后:外链导航不触发 onGone,本应用入口导航(reload)触发', () => {
    setReloadUrlPredicate((url) => url.startsWith('app://renderer/'));
    const onGone = vi.fn();
    const wc = fakeWc(7);
    makeWcGoneHook(onGone)(wc as never);

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/x' });
    expect(onGone).not.toHaveBeenCalled();

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'app://renderer/index.html#a' });
    expect(onGone).not.toHaveBeenCalled();

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'app://renderer/index.html' });
    expect(onGone).toHaveBeenCalledWith(7);
  });

  // 页面发起的导航(details.initiator 为发起 frame)一律被导航守卫拦下 —— 即便指回本应用入口
  //(location.reload()、Vite HMR 整页刷新)文档也不会被替换,不得回收。
  it('页面发起的导航(有 initiator)不触发 onGone,即便目标是本应用入口', () => {
    setReloadUrlPredicate((url) => url.startsWith('app://renderer/'));
    const onGone = vi.fn();
    const wc = fakeWc(9);
    makeWcGoneHook(onGone)(wc as never);

    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'app://renderer/index.html',
      initiator: { url: 'app://renderer/index.html' },
    });
    expect(onGone).not.toHaveBeenCalled();

    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'app://renderer/index.html',
      initiator: null,
    });
    expect(onGone).toHaveBeenCalledWith(9);
  });

  // dev 下导航守卫放行「页面刷新到当前同一 URL」(Vite 整页刷新):文档真的会被替换 → 须照常回收。
  // 判定与导航守卫共用同一注入函数(放行 ⇔ 回收),其余页面发起的导航仍不回收。
  it('被导航守卫放行的页面刷新(同一 URL)触发 onGone;其它页面发起的导航仍不触发', () => {
    setReloadUrlPredicate((url) => url.startsWith('app://renderer/'));
    setPageReloadPredicate((url, currentUrl) => url === currentUrl);
    const onGone = vi.fn();
    const wc = fakeWc(11, 'app://renderer/index.html?windowSeq=0');
    makeWcGoneHook(onGone)(wc as never);
    const initiator = { url: 'app://renderer/index.html?windowSeq=0' };

    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'app://renderer/index.html?windowSeq=0&fresh=1',
      initiator,
    });
    expect(onGone).not.toHaveBeenCalled();

    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'app://renderer/index.html?windowSeq=0',
      initiator,
    });
    expect(onGone).toHaveBeenCalledWith(11);
  });

  it('destroyed 始终触发', () => {
    setReloadUrlPredicate(() => false);
    const onGone = vi.fn();
    const wc = fakeWc(3);
    makeWcGoneHook(onGone)(wc as never);
    wc.emit('destroyed');
    expect(onGone).toHaveBeenCalledWith(3);
  });

  it('main 启动时注入 isOwnRendererUrl 作为 reload 判定', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../electron/main/index.ts'), 'utf8');
    expect(src).toMatch(/setReloadUrlPredicate\(isOwnRendererUrl\)/);
  });
});
