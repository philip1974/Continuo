// topic 49 第二十轮 · popout 窗口关闭也释放窗口级资源(兄弟入口补漏)。
//
// 根因:dockview popout 子窗由 Electron 在 setWindowOpenHandler 返回 action:'allow' 时
// 内部创建,**不走 createMainWindow**,但注入了同一套 PRELOAD,能发起 fs.watch /
// plugin scope 授权 / agent 授权。旧实现把这三项关窗清理只挂在 createMainWindow 的
// win.on('closed') → popout 关闭时 watcher 引用单向累积触顶 MAX_WATCHERS 把活跃窗
// watcher LRU 踢掉、pending scope/agent 授权干等满 5min TTL。
// terminal.ipc 的 windowClosedCleanup 是同类资源,却用了覆盖全窗口的
// browser-window-created 挂载 → 其一漏了 popout 兄弟入口。
// 修复:抽 makeWindowResourceCleanup 工厂,index.ts 在覆盖全窗口的
// browser-window-created 处统一挂载(主窗 createMainWindow 不再各挂一份)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeWindowResourceCleanup } from '../../../electron/main/window-resource-cleanup';

const ROOT = join(__dirname, '..', '..', '..');

describe('topic49 · makeWindowResourceCleanup', () => {
  it('按正确实参清三类资源:scope 用 wcId,fs/agent 用 winId', () => {
    const cancelScopeRequests = vi.fn();
    const releaseFsWatchers = vi.fn();
    const cancelAgentAuth = vi.fn();
    const cleanup = makeWindowResourceCleanup({
      cancelScopeRequests,
      releaseFsWatchers,
      cancelAgentAuth,
    });

    cleanup(/* windowId */ 7, /* webContentsId */ 42);

    expect(cancelScopeRequests).toHaveBeenCalledWith(42);
    expect(releaseFsWatchers).toHaveBeenCalledWith(7);
    expect(cancelAgentAuth).toHaveBeenCalledWith(7);
  });

  it('对从未注册资源的窗口(popout)调用安全:子项均 no-op,不抛', () => {
    const cleanup = makeWindowResourceCleanup({
      cancelScopeRequests: () => {},
      releaseFsWatchers: () => {},
      cancelAgentAuth: () => {},
    });
    expect(() => cleanup(99, 100)).not.toThrow();
  });

  it('重复调用幂等(依赖子项各自幂等):每次都转发,不累积状态', () => {
    const calls: number[] = [];
    const cleanup = makeWindowResourceCleanup({
      cancelScopeRequests: () => calls.push(1),
      releaseFsWatchers: () => calls.push(2),
      cancelAgentAuth: () => calls.push(3),
    });
    cleanup(1, 2);
    cleanup(1, 2);
    expect(calls).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

// 静态守卫:防回退到「只在 createMainWindow 挂三项清理」的 popout 漏清模式。
describe('topic49 · index.ts 经 helper 覆盖全窗口', () => {
  const src = readFileSync(join(ROOT, 'electron/main/index.ts'), 'utf-8');

  it('index.ts 接入 makeWindowResourceCleanup helper', () => {
    expect(src).toMatch(/makeWindowResourceCleanup/);
  });

  it('窗口级资源清理挂在覆盖全窗口的 browser-window-created(含 popout)', () => {
    expect(src).toMatch(/browser-window-created/);
  });
});
