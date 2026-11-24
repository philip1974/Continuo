// BDD:window.open 的目标是否是本应用自己的 renderer 入口(是 → 允许开子窗并注入 preload)。见同目录 README。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isPopoutOnlyUrl } from '../../../electron/main/popout-url';
import {
  installNavigationGuard,
  isAllowedPageReload,
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

// 安全 L1:window.open 放行(注入完整 preload)只为 dockview popout。Markdown 预览中键点
// `file:///…/app.asar/out/renderer/index.html?workspace=%2F&fresh=1&windowSeq=0` 时,只比 pathname
// 会开出一个以攻击者指定目录为根的完整权限应用窗口。popout 子窗只看 `popout` 标记(App 短路成
// PopoutHost,不读 workspace / windowSeq / fresh),故放行要求 query 恰好只有 popout=1。
describe('L1 · window.open 只放行纯 popout URL', () => {
  it('纯 popout URL 放行(file / dev 两种入口)', () => {
    expect(isPopoutOnlyUrl('file:///app/out/renderer/index.html?popout=1')).toBe(true);
    expect(isPopoutOnlyUrl('http://localhost:5173/?popout=1')).toBe(true);
  });

  it('带 workspace / fresh / windowSeq 等启动参数或其它参数的应用入口 URL 拒绝', () => {
    const base = 'file:///app/out/renderer/index.html';
    for (const q of [
      '?workspace=%2F&fresh=1&windowSeq=0',
      '?workspace=%2F&popout=1',
      '?popout=1&fresh=1',
      '?windowSeq=0&popout=1',
      '?foo=bar&popout=1',
      '?popout=1&popout=1',
    ]) {
      expect(isPopoutOnlyUrl(`${base}${q}`), q).toBe(false);
    }
  });

  it('没有 popout 标记 / popout 值不是 1 / 不可解析 / 超长 → 拒绝', () => {
    expect(isPopoutOnlyUrl('file:///app/out/renderer/index.html')).toBe(false);
    expect(isPopoutOnlyUrl('file:///app/out/renderer/index.html?popout=0')).toBe(false);
    expect(isPopoutOnlyUrl('not a url')).toBe(false);
    expect(isPopoutOnlyUrl(`http://localhost:5173/?popout=1#${'a'.repeat(70_000)}`)).toBe(false);
  });

  // index.ts 顶层有 app 副作用,不可直接 import(E146 同法):静态钉住 windowOpenHandler 的放行条件。
  it('windowOpenHandler 的放行条件 = 本应用入口 且 纯 popout URL', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'electron/main/index.ts'), 'utf-8');
    expect(src).toContain('const allow = isOwnRendererUrl(url) && isPopoutOnlyUrl(url);');
  });
});

describe('isOwnRendererWindowUrl 边界', () => {
  it('超长 URL 直接判否,不进 URL 解析', () => {
    const huge = `http://localhost:5173/?q=${'a'.repeat(70_000)}`;
    expect(isOwnRendererWindowUrl(huge, new URL('http://localhost:5173/'), trustedFile)).toBe(false);
  });
});

// 页面内容(如 Markdown 预览里的链接、mermaid 图的 click 链接)被点击时,窗口不能被导航到
// 应用之外 —— 否则整个应用界面被一个网页顶替,且该网页跑在应用窗口里。规则 dev 与打包版一致:
// 页面发起的导航在任何 frame 一律拦,只放行 popout 子窗的首次加载。
describe('installNavigationGuard', () => {
  const APP = 'file:///app/out/renderer/index.html';
  const isOwn = (url: string): boolean => url.startsWith(APP);

  function setup(
    opts: { isOwn?: (url: string) => boolean; currentUrl?: string; allowSameUrlReload?: boolean } = {},
  ) {
    let listener:
      | ((event: { preventDefault(): void; url: string; isMainFrame: boolean }) => void)
      | null = null;
    const onBlocked = vi.fn();
    const contents = {
      currentUrl: opts.currentUrl ?? `${APP}?windowSeq=0`,
      getURL: () => contents.currentUrl,
      on: (event: string, cb: NonNullable<typeof listener>) => {
        expect(event).toBe('will-frame-navigate');
        listener = cb;
      },
    };
    const own = opts.isOwn ?? isOwn;
    installNavigationGuard(contents, own, onBlocked, (url, currentUrl) =>
      isAllowedPageReload(url, currentUrl, opts.allowSameUrlReload ?? false, own),
    );
    const navigate = (url: string, isMainFrame = true) => {
      const preventDefault = vi.fn();
      listener!({ preventDefault, url, isMainFrame });
      return preventDefault;
    };
    return { navigate, onBlocked, contents };
  }

  it('拦下离开本应用 renderer 入口的主框架导航', () => {
    const { navigate } = setup();
    expect(navigate('https://example.com/')).toHaveBeenCalledTimes(1);
    expect(navigate('file:///tmp/evil.html')).toHaveBeenCalledTimes(1);
  });

  // 只拦不转交的话,漏网的链接点击对用户就是「没反应」。被拦的 URL 交给调用方
  //(index.ts 走与 window.open 拒绝分支相同的外链白名单 → 系统浏览器)。
  it('把被拦下的离开本应用的 URL 交给 onBlocked 处理', () => {
    const { navigate, onBlocked } = setup();
    navigate('https://example.com/docs');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith('https://example.com/docs');
  });

  // 页面指回本应用入口的导航(location.reload()、Vite HMR 整页刷新、`<a href="index.html?workspace=…">`)
  // 同样拦下:否则页面内容能以任意启动参数(workspace / fresh)重开当前窗口。也不转交外链(dev 下
  // http://localhost 在白名单里,转交会把 dev 页面开到系统浏览器)。
  it('拦下页面发起的、指回本应用入口的导航(含 reload),且不转交', () => {
    const { navigate, onBlocked } = setup();
    expect(navigate(`${APP}?windowSeq=0`)).toHaveBeenCalledTimes(1);
    expect(navigate(`${APP}?workspace=%2F&fresh=1&windowSeq=0`)).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('子 frame 的导航一律拦下且不转交', () => {
    const { navigate, onBlocked } = setup();
    expect(navigate('https://example.com/embed', false)).toHaveBeenCalledTimes(1);
    expect(navigate(`${APP}?popout=1`, false)).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('DevTools 自己的导航只拦不转交', () => {
    const { navigate, onBlocked } = setup({ isOwn: () => false });
    expect(navigate('devtools://devtools/bundled/devtools_app.html')).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  // window.open 被 windowOpenHandler 放行后,子窗的首次加载在子窗 webContents 上也是页面发起的导航;
  // 拦下它 popout 就是一个空白窗口。
  it('放行 popout 子窗的首次加载(尚无文档 + 本应用入口 + query 恰为 popout=1)', () => {
    const { navigate, onBlocked } = setup({ currentUrl: '' });
    expect(navigate(`${APP}?popout=1`)).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('首次加载的例外只认纯 popout URL:其它 URL / 带启动参数 / 非本应用入口照拦', () => {
    const { navigate, onBlocked } = setup({ currentUrl: '' });
    expect(navigate('https://example.com/')).toHaveBeenCalledTimes(1);
    expect(navigate(`${APP}?workspace=%2F&popout=1`)).toHaveBeenCalledTimes(1);
    expect(navigate('file:///tmp/evil.html?popout=1')).toHaveBeenCalledTimes(1);
    // 离开本应用的两条照常转交(由外链白名单决定是否打开),指回本应用的那条不转交
    expect(onBlocked.mock.calls).toEqual([['https://example.com/'], ['file:///tmp/evil.html?popout=1']]);
  });

  // dev(有 dev server)下 Vite 整页刷新 = location.reload() → 页面发起的、指向当前同一 URL 的主框架导航。
  // 只放行这一种:打包版不放行(页面无权自行刷新,漏网的空链接不会丢未保存内容);带别的参数 / 别的入口照拦。
  it('dev 下放行页面刷新到当前同一 URL;打包版照拦', () => {
    const cur = `${APP}?windowSeq=0`;
    const dev = setup({ currentUrl: cur, allowSameUrlReload: true });
    expect(dev.navigate(cur)).not.toHaveBeenCalled();
    expect(dev.navigate(`${APP}?windowSeq=0&fresh=1`)).toHaveBeenCalledTimes(1);
    expect(dev.navigate(`${APP}?windowSeq=1`)).toHaveBeenCalledTimes(1);
    expect(dev.navigate(cur, false)).toHaveBeenCalledTimes(1); // 子 frame 照拦
    expect(dev.onBlocked).not.toHaveBeenCalled();

    const packaged = setup({ currentUrl: cur, allowSameUrlReload: false });
    expect(packaged.navigate(cur)).toHaveBeenCalledTimes(1);
  });

  it('isAllowedPageReload:须 dev 放开 + 已有文档 + 同一 URL + 本应用入口', () => {
    const cur = `${APP}?windowSeq=0`;
    expect(isAllowedPageReload(cur, cur, true, isOwn)).toBe(true);
    expect(isAllowedPageReload(cur, cur, false, isOwn)).toBe(false);
    expect(isAllowedPageReload('', '', true, () => true)).toBe(false);
    expect(isAllowedPageReload('https://x/', 'https://x/', true, isOwn)).toBe(false);
    // popout 子窗禁止刷新(刷新清空 dockview portal 目标而 main 端状态仍在 → 黑屏;Cmd+R / 菜单已对它屏蔽)。
    expect(isAllowedPageReload(`${APP}?popout=1`, `${APP}?popout=1`, true, isOwn)).toBe(false);
  });

  it('已有文档的窗口再导航到 popout URL 照拦', () => {
    const { navigate } = setup({ currentUrl: `${APP}?popout=1` });
    expect(navigate(`${APP}?popout=1`)).toHaveBeenCalledTimes(1);
  });

  // index.ts 顶层有 app 副作用,不可直接 import:静态钉住守卫装在所有 webContents 上。
  it('main 给每个 webContents 装导航守卫', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'electron/main/index.ts'), 'utf-8');
    expect(src).toContain(
      'installNavigationGuard(contents, isOwnRendererUrl, openExternalFromPage, isPageReloadAllowed);',
    );
    // wc-gone 回收与守卫共用同一放行判定(放行 ⇔ 回收)。
    expect(src).toContain('setPageReloadPredicate(isPageReloadAllowed);');
  });
});
