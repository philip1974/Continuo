// @vitest-environment jsdom
// BDD: command-discoverability —— 窗口类命令作用于触发它的窗口:popout 子窗里「关闭窗口」只关该子窗、「切换全屏」只让该子窗全屏,
// 「重新加载窗口」重载主窗(子窗属于主窗 renderer;VSCode 辅助窗口同)。见同目录 README 第 2 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { windowCommandSpecs } from '../../shell/window-commands';
import { runInCommandDocument } from '../../shell/dock/popout-documents';

const mocks = vi.hoisted(() => ({ closeWindow: vi.fn(), viewAction: vi.fn(), notifyError: vi.fn() }));
vi.mock('../../lib/co-api', () => ({
  coApi: { window: { close: mocks.closeWindow, viewAction: mocks.viewAction } },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: mocks.notifyError, info: vi.fn(), success: vi.fn() },
}));

/** popout 子窗(iframe 的 window 充当;name = dockview 给 window.open 的目标名)。 */
function popoutWindow(name: string): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  win.name = name;
  return win;
}

function spec(id: string) {
  const found = windowCommandSpecs().find((s) => s.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

/** 以 doc 为命令窗口执行(同热键分发 / 菜单 / 子窗里的命令面板)。 */
async function runIn(doc: Document, id: string): Promise<void> {
  await runInCommandDocument(doc, () => spec(id).fn());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeWindow.mockResolvedValue({ ok: true, data: undefined });
  mocks.viewAction.mockResolvedValue({ ok: true, data: undefined });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('popout 子窗里执行窗口类命令', () => {
  it('关闭窗口 → 只关该子窗(子窗 window.close,dockview 把组收回主窗),不经 window:close 关主窗', async () => {
    const child = popoutWindow('dv-1-g2');
    const close = vi.spyOn(child, 'close').mockImplementation(() => {});
    await runIn(child.document, 'workbench.action.closeWindow');
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('切换全屏 → window:view-action 带子窗名,作用于该子窗', async () => {
    const child = popoutWindow('dv-1-g2');
    await runIn(child.document, 'workbench.action.toggleFullScreen');
    expect(mocks.viewAction).toHaveBeenCalledWith('toggleFullScreen', { popoutName: 'dv-1-g2' });
  });

  it('重新加载窗口 → 重载主窗(不带子窗名;子窗界面属于主窗 renderer)', async () => {
    const child = popoutWindow('dv-1-g2');
    await runIn(child.document, 'workbench.action.reloadWindow');
    expect(mocks.viewAction).toHaveBeenCalledWith('reload');
  });

  it('切换全屏失败(子窗已不在)→ 提示错误', async () => {
    mocks.viewAction.mockResolvedValue({ ok: false, code: 'NO_WINDOW', error: 'no popout window' });
    const child = popoutWindow('dv-1-g2');
    await runIn(child.document, 'workbench.action.toggleFullScreen');
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('主窗里执行窗口类命令(行为不变)', () => {
  it('关闭窗口 → window:close;切换全屏 → 不带子窗名', async () => {
    await runIn(document, 'workbench.action.closeWindow');
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
    await runIn(document, 'workbench.action.toggleFullScreen');
    expect(mocks.viewAction).toHaveBeenCalledWith('toggleFullScreen');
  });
});
