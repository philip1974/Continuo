// P2 资源泄漏回归(第八 session R2):plugin-shell-stream 此前只挂 webContents
// 'destroyed' 钩子,漏了 'did-start-navigation'。renderer 整页 reload(Ctrl+R /
// HMR full reload / webContents.reload())时 webContents 不销毁、wcId 不变 →
// 'destroyed' 不触发;且 renderer 侧 for-await iterator 的 return() 不会在 reload
// 时跑(reload 直接撕掉 JS)→ 不发 ABORT → 在途 stream 的子进程 + active 表条目 +
// timeoutTimer 泄漏到 timeout(5-30min),反复 reload 每次累积一个孤儿子进程。
//
// 平行的 plugin-mcp.ipc 早已用 attachWcDestroyHookOnce 挂 did-start-navigation 处理
// reload(审计 #4),该防御未传播到 shell-stream —— 本仓最高频「防御建在一入口,漏
// 平行兄弟入口」族。修复:START 挂钩时镜像 plugin-mcp,额外挂 did-start-navigation,
// 仅 main frame 真实(非同文档)导航才杀该 sender 名下所有在途 stream。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import { registerPluginShellStreamHandlers } from '../../../electron/main/services/plugin-shell-stream.service';

interface NavDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

type Handler = (
  event: { sender: MockWebContents; senderFrame?: { url: string } },
  ...args: unknown[]
) => Promise<void>;

let nextWcId = 1;

class MockWebContents {
  readonly id = nextWcId++;
  readonly send = vi.fn();
  destroyed = false;
  private navHandlers: ((d: NavDetails) => void)[] = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, _handler: () => void): void {
    // 'destroyed' 路径本测试不用,留空即可(production 仍会挂)。
    void event;
    void _handler;
  }

  on(event: string, handler: (d: NavDetails) => void): void {
    if (event === 'did-start-navigation') this.navHandlers.push(handler);
  }

  /** 模拟一次导航(reload 是 isMainFrame=true && isSameDocument=false)。 */
  simulateNavigate(details: NavDetails): void {
    for (const h of this.navHandlers) h(details);
  }

  /** 已挂的 did-start-navigation 监听器数量(用于断言不累积)。 */
  navListenerCount(): number {
    return this.navHandlers.length;
  }

  events(): { streamId: string; kind: string; payload: unknown }[] {
    return this.send.mock.calls
      .filter((c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.EVENT)
      .map((c) => c[1] as { streamId: string; kind: string; payload: unknown });
  }
}

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }
  invoke(sender: MockWebContents, channel: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    // trusted top frame(file://):START/ABORT 现在门控 defaultIsTrustedFrame(R8)。
    return handler(
      { sender, senderFrame: { url: 'file:///app/index.html' } },
      ...args,
    );
  }
}

function makeHarness(): { ipc: FakeIpcMain; sender: MockWebContents } {
  const ipc = new FakeIpcMain();
  registerPluginShellStreamHandlers(ipc as never);
  return { ipc, sender: new MockWebContents() };
}

async function waitForExit(
  sender: MockWebContents,
  streamId: string,
): Promise<{ payload: unknown }> {
  const start = Date.now();
  while (Date.now() - start < 4500) {
    const exit = sender.events().find((e) => e.streamId === streamId && e.kind === 'exit');
    if (exit) return exit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for exit of ${streamId}`);
}

const longRunning = ['-e', 'setInterval(()=>{},1000)'];

describe('49 第八 session · shell-stream renderer reload 杀在途子进程', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('main frame 跨文档导航(reload)→ 杀该 sender 在途 stream 并清 active 表', async () => {
    const { ipc, sender } = makeHarness();
    const streamId = 'reload-victim';
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, streamId, process.execPath, longRunning);

    // 模拟 Ctrl+R:webContents 存活,触发 did-start-navigation(main frame, 非同文档)
    sender.simulateNavigate({ isMainFrame: true, isSameDocument: false });

    // 子进程被 SIGTERM → close → finalize 发 exit。无 fix 时永不发(挂到 timeout)。
    const exit = await waitForExit(sender, streamId);
    expect(exit).toBeTruthy();

    // active 表已清:同 streamId 可立即再次 START 而不抛 "already active"
    await expect(
      ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, streamId, process.execPath, ['-e', 'process.exit(0)']),
    ).resolves.not.toThrow();
    await ipc
      .invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
      .catch(() => undefined);
  }, 8000);

  it('同文档导航(hash / pushState)不杀 stream', async () => {
    const { ipc, sender } = makeHarness();
    const streamId = 'hash-nav-survivor';
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, streamId, process.execPath, longRunning);

    // 同文档导航(hash 改变):不应触发清理
    sender.simulateNavigate({ isMainFrame: true, isSameDocument: true });
    // 子 frame 导航:也不应触发
    sender.simulateNavigate({ isMainFrame: false, isSameDocument: false });

    await new Promise((r) => setTimeout(r, 150));
    // stream 仍活:没有 exit 事件
    expect(sender.events().some((e) => e.streamId === streamId && e.kind === 'exit')).toBe(false);

    // 收尾:ABORT 杀掉
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId);
    await waitForExit(sender, streamId);
  }, 8000);

  it('同一 webContents 反复 START 只挂一个 did-start-navigation 监听器(不累积)', async () => {
    const { ipc, sender } = makeHarness();
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, 's1', process.execPath, longRunning);
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, 's2', process.execPath, longRunning);
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, 's3', process.execPath, longRunning);

    expect(sender.navListenerCount()).toBe(1);

    // 收尾:一次导航杀掉全部三个
    sender.simulateNavigate({ isMainFrame: true, isSameDocument: false });
    await Promise.all([
      waitForExit(sender, 's1'),
      waitForExit(sender, 's2'),
      waitForExit(sender, 's3'),
    ]);
  }, 8000);
});
