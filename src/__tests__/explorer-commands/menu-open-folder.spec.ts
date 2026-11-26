// @vitest-environment jsdom
// BDD:应用菜单「文件 → 打开文件夹… ⌘O」(VSCode 文件菜单同款)即 renderer 命令 workbench.action.files.openFolder:
// main 把执行请求发给目标主窗,renderer 经命令注册表执行。见同目录 README 第 5 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  class FakeBrowserWindow {
    destroyed = false;
    url = 'file:///renderer/index.html';
    opener: object | null = null;
    readonly webContents = {
      send: vi.fn(),
      getURL: () => this.url,
      get opener() {
        return owner.get(this)?.opener ?? null;
      },
    };
    constructor() {
      owner.set(this.webContents, this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }
  const owner = new WeakMap<object, FakeBrowserWindow>();
  const frames = new Map<object, object>(); // opener frame → 其 webContents
  return { FakeBrowserWindow, owner, frames };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(electronMock.FakeBrowserWindow, {
    fromWebContents: (wc: object) => electronMock.owner.get(wc) ?? null,
  }),
  webContents: { fromFrame: (frame: object) => electronMock.frames.get(frame) },
}));

import { WINDOW_CHANNELS, MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { menuCommandTargetWindow, sendMenuCommand } from '../../../electron/main/lib/menu-command';
import { runMenuCommand } from '@/shell/menu-commands';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { OPEN_FOLDER_COMMAND } from '@/panels/Explorer/explorer-commands';

type FakeWin = InstanceType<typeof electronMock.FakeBrowserWindow>;

function popoutOf(main: FakeWin | null): FakeWin {
  const popout = new electronMock.FakeBrowserWindow();
  popout.url = 'file:///renderer/index.html?popout=1';
  if (main) {
    const frame = {};
    popout.opener = frame;
    electronMock.frames.set(frame, main.webContents);
  }
  return popout;
}

describe('main:菜单命令发往哪个窗口', () => {
  it('菜单项即命令:MENU_COMMAND_IDS 登记 openFolder(accelerator 由 renderer 推送的生效键位换算,见 app-menu-bar)', () => {
    expect(MENU_COMMAND_IDS).toContain(OPEN_FOLDER_COMMAND.id);
  });

  it('聚焦的是主窗 → 发给它自己', () => {
    const main = new electronMock.FakeBrowserWindow();
    expect(menuCommandTargetWindow(main as never)).toBe(main);
    expect(sendMenuCommand(main as never, OPEN_FOLDER_COMMAND.id)).toBe(true);
    expect(main.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.RUN_MENU_COMMAND, {
      id: OPEN_FOLDER_COMMAND.id,
      fromPopout: false,
      viaKey: false,
    });
  });

  it('聚焦的是 popout 子窗 → 发给打开它的主窗(子窗的界面由主窗 renderer 驱动)', () => {
    const main = new electronMock.FakeBrowserWindow();
    const popout = popoutOf(main);
    expect(sendMenuCommand(popout as never, OPEN_FOLDER_COMMAND.id)).toBe(true);
    expect(main.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.RUN_MENU_COMMAND, {
      id: OPEN_FOLDER_COMMAND.id,
      fromPopout: true,
      viaKey: false,
    });
    expect(popout.webContents.send).not.toHaveBeenCalled();
  });

  it('没有窗口 / 窗口已销毁 / popout 找不到主窗 → 不发,返回 false(调用方兜底)', () => {
    expect(sendMenuCommand(undefined, OPEN_FOLDER_COMMAND.id)).toBe(false);
    const dead = new electronMock.FakeBrowserWindow();
    dead.destroyed = true;
    expect(sendMenuCommand(dead as never, OPEN_FOLDER_COMMAND.id)).toBe(false);
    const orphan = popoutOf(null);
    expect(sendMenuCommand(orphan as never, OPEN_FOLDER_COMMAND.id)).toBe(false);
    expect(orphan.webContents.send).not.toHaveBeenCalled();
  });
});

describe('renderer:收到菜单命令 → 经命令注册表执行', () => {
  let reg: CommandRegistry;
  let fn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    reg = new CommandRegistry();
    fn = vi.fn();
    reg.register({ id: OPEN_FOLDER_COMMAND.id, title: 'Open Folder…', fn });
    reg.register({ id: 'other.cmd', title: 'Other', fn: vi.fn() });
  });
  afterEach(() => document.body.replaceChildren());

  it('登记过的菜单命令 → 执行一次', async () => {
    runMenuCommand(reg, { id: OPEN_FOLDER_COMMAND.id, fromPopout: false, viaKey: false });
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('不在 MENU_COMMAND_IDS 里的 id / 非法 payload → 忽略(通道只为菜单项服务)', async () => {
    runMenuCommand(reg, { id: 'other.cmd', fromPopout: false, viaKey: false });
    runMenuCommand(reg, 42);
    await Promise.resolve();
    expect(reg.get('other.cmd')!.fn).not.toHaveBeenCalled();
  });

  it('有 Modal 打开 → 不执行(与快捷键一致:对话框期间工作台命令不执行)', async () => {
    const { render } = await import('@testing-library/react');
    const { createElement } = await import('react');
    const { Modal } = await import('@/design');
    const view = render(createElement(Modal, { visible: true, onClose: () => {}, 'aria-label': 'x', children: 'body' }));
    runMenuCommand(reg, { id: OPEN_FOLDER_COMMAND.id, fromPopout: false, viaKey: false });
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
    view.unmount();
  });
});
