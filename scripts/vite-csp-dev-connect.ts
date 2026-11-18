import type { Plugin } from 'vite';

// 纵深(CSP):index.html 的 connect-src 只写生产所需来源('self' https:)。开发期 Vite HMR 需连
// localhost 的 http / ws,由本插件仅在 dev server(apply: 'serve')把这些来源加回;生产构建
//(`pnpm build` / 打包)产物不再放行本机明文 http / ws 服务(`https:` 为协议级来源,仍放行
// https://localhost,属预期)。
// 见 src/__tests__/49-polish-bugfixes/csp-localhost-dev-only.spec.ts。

export const DEV_CONNECT_SOURCES = 'ws://localhost:* wss://localhost:* http://localhost:*';

const CONNECT_SRC_ANCHOR = "connect-src 'self' https:;";

/** 在 CSP 的 connect-src 末尾追加 dev 来源;找不到锚点即抛错(index.html 改了 CSP 须同步此处)。 */
export function addDevConnectSources(html: string): string {
  if (!html.includes(CONNECT_SRC_ANCHOR)) {
    throw new Error(`index.html CSP 缺少 "${CONNECT_SRC_ANCHOR}",无法为 dev HMR 注入 connect-src 来源`);
  }
  return html.replace(CONNECT_SRC_ANCHOR, `connect-src 'self' https: ${DEV_CONNECT_SOURCES};`);
}

export function cspDevConnectPlugin(): Plugin {
  return {
    name: 'continuo:csp-dev-connect',
    apply: 'serve',
    transformIndexHtml: (html) => addDevConnectSources(html),
  };
}
