// BDD:window.open 的目标是否是本应用自己的 renderer 入口(是 → 允许开子窗并注入 preload)。见同目录 README。
import { describe, expect, it, vi } from 'vitest';
import {
  installNavigationGuard,
  isOwnRendererWindowUrl,
} from '../../../electron/main/window-open-policy';

const trustedFile = (url: string): boolean =>
  url.startsWith('file:///app/out/renderer/index.html');

describe('isOwnRendererWindowUrl', () => {
  it('有 dev server:只认同源 URL', () => {
    const dev = new URL('http://localhost:5173/');
    expect(isOwnRendererWindowUrl('http://localhost:5173/?popout=1', dev, trustedFile)).toBe(true);
    expect(isOwnRendererWindowUrl('http://localhost:9999/?popout=1', dev, trustedFile)).toBe(false);
    expect(isOwnRendererWindowUrl('file:///app/out/renderer/index.html?popout=1', dev, trustedFile)).toBe(false);
    expect(isOwnRendererWindowUrl('not a url', dev, trustedFile)).toBe(false);
  });

  // 未打包但也没有 dev server(`electron out/main/index.js`:预览 / e2e)时主窗是 loadFile 加载的。
  // 此前这种情况按「dev」处理、要求同源 dev URL,而 dev URL 不存在 → 所有 popout 都被拒,子窗开不出来。
  it('没有 dev server(含未打包的本地构建)→ 与主窗一致,认受信的 renderer 文件入口', () => {
    expect(
      isOwnRendererWindowUrl('file:///app/out/renderer/index.html?windowSeq=0&popout=1', null, trustedFile),
    ).toBe(true);
    expect(isOwnRendererWindowUrl('file:///tmp/evil.html', null, trustedFile)).toBe(false);
    expect(isOwnRendererWindowUrl('https://example.com/', null, trustedFile)).toBe(false);
  });
});

describe('isOwnRendererWindowUrl 边界', () => {
  it('超长 URL 直接判否,不进 URL 解析', () => {
    const huge = `http://localhost:5173/?q=${'a'.repeat(70_000)}`;
    expect(isOwnRendererWindowUrl(huge, new URL('http://localhost:5173/'), trustedFile)).toBe(false);
  });
});

// 页面内容(如 Markdown 预览里的链接、mermaid 图的 click 链接)被点击时,窗口不能被导航到
// 应用之外 —— 否则整个应用界面被一个网页顶替,且该网页跑在应用窗口里。
describe('installNavigationGuard', () => {
  function setup(isOwn: (url: string) => boolean) {
    let listener: ((event: { preventDefault(): void; url: string }) => void) | null = null;
    const onBlocked = vi.fn();
    installNavigationGuard(
      {
        on: (event, cb) => {
          expect(event).toBe('will-navigate');
          listener = cb;
        },
      },
      isOwn,
      onBlocked,
    );
    const navigate = (url: string) => {
      const preventDefault = vi.fn();
      listener!({ preventDefault, url });
      return preventDefault;
    };
    return { navigate, onBlocked };
  }
  const isOwn = (url: string): boolean =>
    url.startsWith('file:///app/out/renderer/index.html');

  it('拦下离开本应用 renderer 入口的主框架导航', () => {
    const { navigate } = setup(isOwn);
    expect(navigate('https://example.com/')).toHaveBeenCalledTimes(1);
    expect(navigate('file:///tmp/evil.html')).toHaveBeenCalledTimes(1);
  });

  // 只拦不转交的话,漏网的链接点击对用户就是「没反应」。被拦的 URL 交给调用方
  //(index.ts 走与 window.open 拒绝分支相同的外链白名单 → 系统浏览器)。
  it('把被拦下的 URL 交给 onBlocked 处理', () => {
    const { navigate, onBlocked } = setup(isOwn);
    navigate('https://example.com/docs');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('放行回到本应用 renderer 入口的导航(如 dev 重载)', () => {
    const { navigate, onBlocked } = setup(isOwn);
    expect(navigate('file:///app/out/renderer/index.html?windowSeq=0')).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('不干涉 DevTools 自己的导航', () => {
    const { navigate, onBlocked } = setup(() => false);
    expect(navigate('devtools://devtools/bundled/devtools_app.html')).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
