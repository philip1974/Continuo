import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Debug 事件同步必须在 renderer 启动时就开始,不能等懒加载的 DebugPanel 挂载:默认布局里没有
// Debug 面板,agent 命中断点时没人收事件 —— 编辑器的断点红点 / 停靠行不显示。(renderer 重载后的恢复
// 靠 subscribe 快照,见 debug-store.spec。)
// init() 牵涉整个 shell 启动,这里钉住启动入口的接线(行为本身由 debug-store.spec 覆盖)。
describe('topic51 · debug store 同步在 renderer 启动时开始', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/main-app.ts'), 'utf8');

  it('main-app 的 init() 在首次渲染前调用 startDebugStoreSync()', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bstartDebugStoreSync\b[^}]*\}\s*from\s*'[^']*stores\/debug\.store'/);
    const call = source.indexOf('startDebugStoreSync();');
    const render = source.indexOf('createRoot(container).render(');
    expect(call).toBeGreaterThan(source.indexOf('export async function init'));
    expect(call).toBeLessThan(render);
  });
});
