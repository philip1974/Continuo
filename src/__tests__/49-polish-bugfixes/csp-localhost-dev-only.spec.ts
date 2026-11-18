// 纵深(CSP):生产 renderer 的 connect-src 不得放行 http://localhost:* / ws://localhost:*。这两项只为开发期
// Vite HMR 服务;留在生产 CSP 里,renderer 一旦被注入脚本即可探测 / 攻击本机任意端口的 HTTP / WebSocket 服务。
// 契约:index.html 源文件(= 生产构建产物来源)的 connect-src 不含 localhost;renderer 插件只在 dev(serve)
// 把 localhost 来源加回 connect-src。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEV_CONNECT_SOURCES,
  addDevConnectSources,
  cspDevConnectPlugin,
} from '../../../scripts/vite-csp-dev-connect';

const ROOT = join(__dirname, '../../..');

function connectSrc(html: string): string {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
  expect(csp).toBeDefined();
  const directive = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  expect(directive).toBeDefined();
  return directive!;
}

describe('CSP connect-src:localhost 仅开发构建放行', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('index.html(生产构建来源)的 connect-src 不含 localhost', () => {
    expect(connectSrc(html)).not.toMatch(/localhost/);
    expect(connectSrc(html)).toBe('connect-src https:');
  });

  // 安全:打包版页面源是 file://,'self' 在此前提下匹配**全盘** file: URL。connect-src 带 'self' 时,任何脚本
  // 都能 fetch / XHR 读任意本地文件;页面内的请求有主进程 file: 目录围栏兜底,但 **Worker 内部**的
  // fetch / XHR 完全不经过 webRequest(Electron 45 实测),只有 CSP 能拦(blob: Worker 继承页面 CSP)。
  // 应用自身从不 fetch 自己的 file: 资源(脚本 / 样式 / 字体走各自指令),故生产 connect-src 不写 'self'。
  it("index.html(生产构建来源)的 connect-src 不含 'self'(file:// 源下 'self' = 全盘 file:)", () => {
    expect(connectSrc(html)).not.toContain("'self'");
  });

  it("dev 变换把 'self'(http dev server 同源)与 HMR 所需的 localhost 来源加回 connect-src,其余指令不变", () => {
    const dev = addDevConnectSources(html);
    expect(connectSrc(dev)).toBe(`connect-src 'self' https: ${DEV_CONNECT_SOURCES}`);
    for (const src of ['ws://localhost:*', 'wss://localhost:*', 'http://localhost:*']) {
      expect(connectSrc(dev)).toContain(src);
    }
    expect(dev.replace(`connect-src 'self' https: ${DEV_CONNECT_SOURCES}`, 'connect-src https:')).toBe(html);
  });

  it('找不到 connect-src 锚点时抛错(dev 下不静默丢失 HMR 来源)', () => {
    expect(() => addDevConnectSources('<html></html>')).toThrow(/connect-src/);
  });

  it('插件只作用于 dev server(apply: serve),并挂在 renderer 插件列表', () => {
    const plugin = cspDevConnectPlugin();
    expect(plugin.apply).toBe('serve');
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8');
    const renderer = config.slice(config.indexOf('renderer:'));
    expect(renderer).toMatch(/plugins:\s*\[[^\]]*cspDevConnectPlugin\(\)/);
  });
});
