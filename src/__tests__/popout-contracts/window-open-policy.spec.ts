// BDD:window.open 的目标是否是本应用自己的 renderer 入口(是 → 允许开子窗并注入 preload)。见同目录 README。
import { describe, expect, it } from 'vitest';
import { isOwnRendererWindowUrl } from '../../../electron/main/window-open-policy';

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
