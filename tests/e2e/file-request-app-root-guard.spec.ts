// 主进程兜底:file:// 页面下 CSP 的 'self' 匹配全盘 file: URL,页面内脚本(插件 / 被注入的内容)本可
// <script src> / import() / <link> / <iframe> / fetch 工作区里的任意文件。守卫把 file: 请求围在应用自身
// renderer 目录内;目录之外只有图片放行(Markdown 预览的本地绝对路径图片)。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures/with-workspace';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('工作区里的文件不能经 file: 被页面当脚本 / 样式 / 子框架加载或读取,本地图片仍可显示', async ({
  window,
  workspaceRoot,
}) => {
  await expect(window.locator('main')).toBeVisible({ timeout: 10_000 });
  writeFileSync(path.join(workspaceRoot, 'evil.js'), 'window.__fileGuardEvil = "RAN";\n');
  writeFileSync(path.join(workspaceRoot, 'evilmod.js'), 'export default "EVILMOD";\n');
  writeFileSync(path.join(workspaceRoot, 'evil.css'), 'body{outline-style:dashed}\n');
  writeFileSync(path.join(workspaceRoot, 'page.html'), '<html><body>LOCALPAGE</body></html>\n');
  writeFileSync(path.join(workspaceRoot, 'secret.txt'), 'TOPSECRET\n');
  writeFileSync(path.join(workspaceRoot, 'pic.png'), PNG_1X1);
  const base = pathToFileURL(workspaceRoot).href;

  const result = await window.evaluate(async (base) => {
    const load = (tag: string, attrs: Record<string, string>, parent: HTMLElement): Promise<boolean> =>
      new Promise((resolve) => {
        const n = document.createElement(tag);
        n.onload = () => resolve(true);
        n.onerror = () => resolve(false);
        Object.assign(n, attrs);
        parent.appendChild(n);
      });
    const settle = (p: Promise<string>): Promise<string> =>
      Promise.race([p, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 3_000))]).catch(
        (e: unknown) => 'ERR ' + String(e),
      );
    const script = await load('script', { src: `${base}/evil.js` }, document.body);
    const dynImport = await settle(
      (import(/* @vite-ignore */ `${base}/evilmod.js`) as Promise<{ default: string }>).then((m) => 'LOADED ' + m.default),
    );
    const stylesheet = await load('link', { rel: 'stylesheet', href: `${base}/evil.css` }, document.head);
    const iframeText = await settle(
      new Promise<string>((resolve) => {
        const f = document.createElement('iframe');
        f.onload = () => resolve(f.contentDocument?.body?.textContent ?? '');
        f.src = `${base}/page.html`;
        document.body.appendChild(f);
      }),
    );
    // 应用在生产构建下抹掉了全局 fetch;从全新 iframe 取一个原生 fetch 来验证读取路径
    const fresh = document.createElement('iframe');
    document.body.appendChild(fresh);
    const freshFetch = (fresh.contentWindow as unknown as { fetch: typeof fetch }).fetch;
    const fetched = await settle(freshFetch(`${base}/secret.txt`).then((r) => r.text()));
    const image = await load('img', { src: `${base}/pic.png` }, document.body);
    return {
      script,
      marker: (window as unknown as { __fileGuardEvil?: string }).__fileGuardEvil ?? null,
      dynImport,
      stylesheet,
      outline: getComputedStyle(document.body).outlineStyle,
      iframeText,
      fetched,
      image,
    };
  }, base);

  expect(result.script).toBe(false);
  expect(result.marker).toBeNull();
  expect(result.dynImport).toMatch(/^ERR /);
  expect(result.stylesheet).toBe(false);
  expect(result.outline).not.toBe('dashed');
  expect(result.iframeText).not.toContain('LOCALPAGE');
  expect(result.fetched).not.toContain('TOPSECRET');
  expect(result.fetched).toMatch(/^ERR /);
  expect(result.image).toBe(true);
  // 应用自身界面不受影响
  await expect(window.locator('main')).toBeVisible();
});
