// BDD: app-menu-bar 第 2 条 —— 菜单快捷键显示跟随生效键位:renderer 按命令面板同一规则算出菜单命令的生效主键(改键 / 解绑 /
// 冲突落败 / 保留键)推给 main;main 换算成 accelerator,有变化才重建菜单。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU_COMMAND_IDS, WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import { hotkeyToAccelerator, menuAcceleratorOf, setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { menuKeybindings } from '@/shell/menu-commands';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => ({ handlers: new Map<string, InvokeHandler>() }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

describe('main:hotkey(归一后)→ Electron accelerator', () => {
  it.each([
    ['meta+/', true, 'Command+/'],
    ['meta+alt+s', true, 'Command+Alt+S'],
    ['ctrl+`', true, 'Control+`'],
    ['ctrl+shift+-', true, 'Control+Shift+-'],
    ['meta+shift+p', true, 'Command+Shift+P'],
    ['alt+arrowup', true, 'Alt+Up'],
    ['meta+alt+arrowdown', true, 'Command+Alt+Down'],
    ['meta+shift+enter', true, 'Command+Shift+Return'],
    ['meta+shift+\\', true, 'Command+Shift+\\'],
    ['meta++', true, 'Command+Plus'],
    ['f1', true, 'F1'],
    ['ctrl+o', false, 'Ctrl+O'],
    ['meta+t', false, 'Super+T'],
    ['ctrl+alt+arrowleft', false, 'Ctrl+Alt+Left'],
    ['ctrl+numpad1', false, 'Ctrl+num1'],
  ])('%s(mac=%s)→ %s', (hotkey, isMac, accelerator) => {
    expect(hotkeyToAccelerator(hotkey, isMac)).toBe(accelerator);
  });

  it.each(['hyper+x', 'meta+dead', 'meta+', ''])('无法表示 %j → undefined(菜单项不显示键位)', (hotkey) => {
    expect(hotkeyToAccelerator(hotkey, true)).toBeUndefined();
  });
});

describe('main:记下推送的键位', () => {
  beforeEach(() => setMenuKeybindings({}));

  it('有变化才报告变化;只认菜单命令 id,非字符串 / 超长值忽略', () => {
    expect(setMenuKeybindings({ 'terminal.new': 'meta+t' })).toBe(true);
    expect(setMenuKeybindings({ 'terminal.new': 'meta+t' })).toBe(false);
    expect(menuAcceleratorOf('terminal.new', true)).toBe('Command+T');
    expect(setMenuKeybindings({ 'terminal.new': 'meta+t', 'other.cmd': 'meta+x', 'workbench.action.gotoLine': 42 })).toBe(false);
    expect(setMenuKeybindings({ 'terminal.new': 'x'.repeat(65) })).toBe(true);
    expect(menuAcceleratorOf('terminal.new', true)).toBeUndefined();
  });
});

describe('main:window:set-menu-keybindings', () => {
  const rebuildAppMenu = vi.fn();
  const invoke = (raw: unknown): Promise<unknown> =>
    electronMock.handlers.get(WINDOW_CHANNELS.SET_MENU_KEYBINDINGS)!(
      { sender: {}, senderFrame: { url: 'file:///app/index.html' } },
      raw,
    );

  beforeEach(() => {
    setMenuKeybindings({});
    rebuildAppMenu.mockClear();
    electronMock.handlers.clear();
    registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu });
  });

  it('键位变化 → 重建菜单;相同内容再推不重建', async () => {
    expect(await invoke({ keybindings: { 'editor.action.commentLine': 'meta+/', 'terminal.new': null } })).toMatchObject({ ok: true });
    expect(rebuildAppMenu).toHaveBeenCalledTimes(1);
    expect(menuAcceleratorOf('editor.action.commentLine', true)).toBe('Command+/');
    await invoke({ keybindings: { 'editor.action.commentLine': 'meta+/', 'terminal.new': null } });
    expect(rebuildAppMenu).toHaveBeenCalledTimes(1);
  });

  it('非菜单命令 id / 多余字段 / 超长值 → 拒绝,不重建', async () => {
    for (const raw of [
      { keybindings: { 'other.cmd': 'meta+x' } },
      { keybindings: {}, extra: 1 },
      { keybindings: { 'terminal.new': 'x'.repeat(65) } },
    ]) {
      expect(await invoke(raw)).toMatchObject({ ok: false });
    }
    expect(rebuildAppMenu).not.toHaveBeenCalled();
  });
});

describe('renderer:菜单命令的生效主键(与命令面板同一规则)', () => {
  function registry(): CommandRegistry {
    const reg = new CommandRegistry('mac');
    reg.register({ id: 'editor.action.commentLine', title: 'Toggle Line Comment', hotkey: 'mod+/', when: 'editorTextFocus', fn: vi.fn() });
    reg.register({ id: 'terminal.new', title: 'New Terminal', hotkey: 'ctrl+shift+`', fn: vi.fn() });
    reg.register({ id: 'workbench.action.quickOpen', title: 'Go to File…', fn: vi.fn() });
    reg.register({ id: 'workbench.action.files.saveAll', title: 'Save All', hotkey: 'mod+alt+s', fn: vi.fn() });
    return reg;
  }
  const keys = (reg: CommandRegistry, overrides: Record<string, string> = {}) =>
    menuKeybindings(reg, reg.getAll(), overrides, 'mac');

  it('默认键归一;未注册的菜单命令 → null;⌘P 保留键归属命令显示保留键', () => {
    const k = keys(registry());
    expect(Object.keys(k).sort()).toEqual([...MENU_COMMAND_IDS].sort());
    expect(k['editor.action.commentLine']).toBe('meta+/');
    expect(k['terminal.new']).toBe('ctrl+shift+`');
    expect(k['workbench.action.files.saveAll']).toBe('meta+alt+s');
    expect(k['workbench.action.quickOpen']).toBe('meta+p');
    expect(k['workbench.action.gotoLine']).toBeNull();
  });

  it('改键跟随;解绑(空串)→ null', () => {
    const k = keys(registry(), { 'editor.action.commentLine': 'mod+shift+7', 'workbench.action.files.saveAll': '' });
    expect(k['editor.action.commentLine']).toBe('meta+shift+7');
    expect(k['workbench.action.files.saveAll']).toBeNull();
  });

  it('与别的命令冲突落败(按下执行别的命令)→ null;条件不同的同键不算落败', () => {
    const reg = registry();
    reg.register({ id: 'other.cmd', title: 'Other', fn: vi.fn() });
    // 用户把别的命令改到「新建终端」的默认键:用户绑定胜出,新建终端按下不再执行 → 菜单不显示
    expect(keys(reg, { 'other.cmd': 'ctrl+shift+`' })['terminal.new']).toBeNull();
    // 全部保存改到 ⌘/:⌘/ 上的 commentLine 只在编辑器正文成立,不算压过
    expect(keys(reg, { 'workbench.action.files.saveAll': 'mod+/' })['workbench.action.files.saveAll']).toBe('meta+/');
  });

  it('「设置…」(workbench.action.openSettings,只打开、无自身键位)显示 settings.toggle 的生效键位 ⌘,,改键 / 解绑跟随', () => {
    const reg = registry();
    reg.register({ id: 'workbench.action.openSettings', title: 'Open Settings', fn: vi.fn() });
    reg.register({ id: 'settings.toggle', title: 'Toggle Settings', hotkey: 'mod+,', fn: vi.fn() });
    expect(keys(reg)['workbench.action.openSettings']).toBe('meta+,');
    expect(keys(reg, { 'settings.toggle': 'mod+shift+y' })['workbench.action.openSettings']).toBe('meta+shift+y');
    expect(keys(reg, { 'settings.toggle': '' })['workbench.action.openSettings']).toBeNull();
  });
});
