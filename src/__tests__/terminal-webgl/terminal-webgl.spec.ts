// @vitest-environment jsdom
// BDD:终端 WebGL 渲染器的名额(LRU 让出隐藏终端)、显隐、上下文丢失退避重试、换窗口重建(对齐 VSCode xtermTerminal)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  MAX_TERMINAL_WEBGL,
  WEBGL_RETRY_BASE_MS,
  WEBGL_RETRY_LIMIT,
  activeTerminalWebglCount,
  createTerminalWebgl,
  type TerminalWebgl,
} from '../../panels/Terminal/terminal-webgl';

interface FakeAddon {
  disposed: boolean;
  loseContext(): void;
}

function harness(opts: { failCreate?: boolean; element?: unknown } = {}) {
  const addons: FakeAddon[] = [];
  const element = (opts.element ?? { ownerDocument: { defaultView: window as Window } }) as {
    ownerDocument: { defaultView: Window };
  };
  const term = { loadAddon: vi.fn(), element } as unknown as Terminal;
  const onRendererChange = vi.fn();
  const webgl = createTerminalWebgl(term, {
    onRendererChange,
    createAddon: () => {
      if (opts.failCreate) throw new Error('WebGL2 not supported');
      let cb: (() => void) | null = null;
      const addon = {
        disposed: false,
        onContextLoss: (fn: () => void) => {
          cb = fn;
          return { dispose: () => (cb = null) };
        },
        dispose: () => {
          addon.disposed = true;
        },
        loseContext: () => cb?.(),
      };
      addons.push(addon);
      return addon;
    },
  });
  return {
    webgl,
    addons,
    element,
    onRendererChange,
    /** 当前装着的 addon(最后一个未 dispose 的)。 */
    get live(): FakeAddon | undefined {
      return addons.filter((a) => !a.disposed).at(-1);
    },
  };
}

type Harness = ReturnType<typeof harness>;
let made: TerminalWebgl[] = [];
function make(opts?: { failCreate?: boolean; element?: unknown }): Harness {
  const h = harness(opts);
  made.push(h.webgl);
  return h;
}
const nextFrame = () => vi.advanceTimersToNextFrame();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const w of made) w.dispose();
  made = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('延后安装与显隐', () => {
  it('可见:下一帧才装 WebGL;隐藏创建的不装,首次显示后下一帧装;装前又隐藏则取消', () => {
    const a = make();
    a.webgl.setVisible(true);
    expect(a.addons).toHaveLength(0);
    nextFrame();
    expect(a.webgl.active).toBe(true);
    expect(a.onRendererChange).toHaveBeenCalledTimes(1);

    const b = make();
    b.webgl.setVisible(false);
    nextFrame();
    expect(b.addons).toHaveLength(0);
    b.webgl.setVisible(true);
    b.webgl.setVisible(false);
    nextFrame();
    expect(b.addons).toHaveLength(0);
    b.webgl.setVisible(true);
    nextFrame();
    expect(b.webgl.active).toBe(true);
  });

  it('名额未满时切 tab(隐藏 / 重新显示)不卸不装', () => {
    const a = make();
    a.webgl.setVisible(true);
    nextFrame();
    for (let i = 0; i < 5; i++) {
      a.webgl.setVisible(false);
      nextFrame();
      a.webgl.setVisible(true);
      nextFrame();
    }
    expect(a.addons).toHaveLength(1);
    expect(a.webgl.active).toBe(true);
  });

  it('dispose 释放名额,未触发的安装帧取消', () => {
    const a = make();
    a.webgl.setVisible(true);
    nextFrame();
    const before = activeTerminalWebglCount();
    a.webgl.dispose();
    expect(activeTerminalWebglCount()).toBe(before - 1);
    expect(a.addons[0]!.disposed).toBe(true);
    const b = make();
    b.webgl.setVisible(true);
    b.webgl.dispose();
    nextFrame();
    expect(b.addons).toHaveLength(0);
  });
});

describe('名额:超过上限时让出的是最久没显示的隐藏终端', () => {
  it('连建 20 个终端(每建一个切过去):始终不超过上限,可见的那个一直是 WebGL;最早隐藏的先让出', () => {
    const terms: Harness[] = [];
    for (let i = 0; i < 20; i++) {
      terms.at(-1)?.webgl.setVisible(false);
      const t = make();
      t.webgl.setVisible(true);
      nextFrame();
      terms.push(t);
      expect(activeTerminalWebglCount()).toBeLessThanOrEqual(MAX_TERMINAL_WEBGL);
      expect(t.webgl.active).toBe(true);
    }
    const active = terms.map((t) => t.webgl.active);
    expect(active.slice(0, 20 - MAX_TERMINAL_WEBGL).every((x) => !x)).toBe(true);
    expect(active.slice(20 - MAX_TERMINAL_WEBGL).every(Boolean)).toBe(true);
    // 让出的是卸掉 addon(回退 DOM),并请求重新 fit
    expect(terms[0]!.addons[0]!.disposed).toBe(true);
    expect(terms[0]!.onRendererChange).toHaveBeenCalledTimes(2);

    // 切回最早的终端:重新装上,让出当前最久没显示的隐藏终端(terms[8])
    terms[19]!.webgl.setVisible(false);
    terms[0]!.webgl.setVisible(true);
    nextFrame();
    expect(terms[0]!.webgl.active).toBe(true);
    expect(terms[20 - MAX_TERMINAL_WEBGL]!.webgl.active).toBe(false);
    expect(terms[19]!.webgl.active).toBe(true);
    expect(activeTerminalWebglCount()).toBe(MAX_TERMINAL_WEBGL);
  });

  it('拆分并排:同时可见的终端都不被让出;全是可见终端时照装(超出由浏览器处理)', () => {
    const visible: Harness[] = [];
    for (let i = 0; i < MAX_TERMINAL_WEBGL + 2; i++) {
      const t = make();
      t.webgl.setVisible(true);
      nextFrame();
      visible.push(t);
    }
    expect(visible.every((t) => t.webgl.active)).toBe(true);
  });
});

describe('让出 / 关闭时立即释放 WebGL 上下文(不等垃圾回收,否则仍计入浏览器上限)', () => {
  it('卸掉 addon 后对其 canvas 的 webgl2 上下文 loseContext;链接层等 2d canvas(xterm-*-layer)不碰', () => {
    const element = document.createElement('div');
    const screen = element.appendChild(document.createElement('div'));
    screen.className = 'xterm-screen';
    const linkLayer = screen.appendChild(document.createElement('canvas'));
    linkLayer.className = 'xterm-link-layer';
    const glCanvas = screen.appendChild(document.createElement('canvas'));
    const loseContext = vi.fn();
    const linkGetContext = vi.fn(() => null);
    linkLayer.getContext = linkGetContext as never;
    glCanvas.getContext = vi.fn((type: string) =>
      type === 'webgl2' ? { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null) } : null,
    ) as never;
    // 名额满后让出:用真实 DOM 元素的终端最先建、随后隐藏
    const victim = make({ element });
    victim.webgl.setVisible(true);
    nextFrame();
    victim.webgl.setVisible(false);
    for (let i = 0; i < MAX_TERMINAL_WEBGL; i++) {
      const t = make();
      t.webgl.setVisible(true);
      nextFrame();
    }
    expect(victim.webgl.active).toBe(false);
    expect(victim.addons[0]!.disposed).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(linkGetContext).not.toHaveBeenCalled();

    // 终端关闭(dispose)同样释放
    victim.webgl.setVisible(true);
    nextFrame();
    expect(victim.webgl.active).toBe(true);
    victim.webgl.dispose();
    expect(loseContext).toHaveBeenCalledTimes(2);
  });
});

describe('上下文丢失:回退 DOM,可见时退避重试,有上限', () => {
  it('可见时丢失:立即卸掉,1s / 2s / 4s 后重装;第 4 次丢失后不再重试', () => {
    const a = make();
    a.webgl.setVisible(true);
    nextFrame();
    for (let n = 1; n <= WEBGL_RETRY_LIMIT; n++) {
      a.live!.loseContext();
      expect(a.webgl.active).toBe(false);
      const delay = WEBGL_RETRY_BASE_MS * 2 ** (n - 1);
      vi.advanceTimersByTime(delay - 1);
      expect(a.webgl.active).toBe(false);
      vi.advanceTimersByTime(1);
      nextFrame();
      expect(a.webgl.active).toBe(true);
    }
    a.live!.loseContext();
    vi.advanceTimersByTime(60_000);
    nextFrame();
    a.webgl.setVisible(false);
    a.webgl.setVisible(true);
    nextFrame();
    expect(a.webgl.active).toBe(false);
    expect(a.addons).toHaveLength(WEBGL_RETRY_LIMIT + 1);
  });

  it('隐藏时丢失:退避到期也不装,重新显示后下一帧装', () => {
    const a = make();
    a.webgl.setVisible(true);
    nextFrame();
    a.webgl.setVisible(false);
    a.live!.loseContext();
    vi.advanceTimersByTime(WEBGL_RETRY_BASE_MS);
    nextFrame();
    expect(a.webgl.active).toBe(false);
    a.webgl.setVisible(true);
    nextFrame();
    expect(a.webgl.active).toBe(true);
  });

  it('WebGL 不可用(创建抛错):保持 DOM,不再重试', () => {
    const a = make({ failCreate: true });
    a.webgl.setVisible(true);
    nextFrame();
    expect(a.webgl.active).toBe(false);
    a.webgl.setVisible(false);
    a.webgl.setVisible(true);
    nextFrame();
    expect(a.webgl.active).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('换窗口(拖进 / 拖出 popout 子窗)', () => {
  it('在另一个窗口里重新可见:重建渲染器;同窗口重复显示不重建', () => {
    const a = make();
    a.webgl.setVisible(true);
    nextFrame();
    a.webgl.setVisible(true);
    nextFrame();
    expect(a.addons).toHaveLength(1);
    const popout = { requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
    a.element.ownerDocument.defaultView = popout as unknown as Window;
    a.webgl.setVisible(true);
    expect(a.addons[0]!.disposed).toBe(true);
    nextFrame();
    expect(a.addons).toHaveLength(2);
    expect(a.webgl.active).toBe(true);
  });
});
