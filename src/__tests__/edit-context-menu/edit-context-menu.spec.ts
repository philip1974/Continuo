// BDD:可编辑元素原生右键菜单(剪切 / 复制 / 粘贴 / 全选)。见同目录 README。
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildFromTemplate, popup, localeRef } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  localeRef: { current: 'en' as 'en' | 'zh' | 'ko' },
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate },
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: () => localeRef.current,
}));

import { installEditContextMenu } from '../../../electron/main/edit-context-menu';
import { getMainT } from '../../../electron/main/i18n';

interface Flags {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

const ALL: Flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const NONE: Flags = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };

function makeWindow() {
  const webContents = new EventEmitter();
  const win = { webContents };
  installEditContextMenu(win as never, getMainT);
  return {
    win,
    rightClick: (params: { isEditable: boolean; selectionText: string; editFlags: Flags }) =>
      webContents.emit('context-menu', { preventDefault: vi.fn() }, params),
  };
}

type Item = { role?: string; type?: string; label?: string; enabled?: boolean };
const lastTemplate = (): Item[] => buildFromTemplate.mock.lastCall![0] as Item[];

beforeEach(() => {
  buildFromTemplate.mockReset();
  popup.mockReset();
  buildFromTemplate.mockImplementation(() => ({ popup }));
  localeRef.current = 'en';
});

describe('可编辑元素右键 → 原生编辑菜单', () => {
  it('可编辑元素:剪切 / 复制 / 粘贴 / 分隔 / 全选(role 项),弹在该窗口', () => {
    const { win, rightClick } = makeWindow();
    rightClick({ isEditable: true, selectionText: 'abc', editFlags: ALL });

    expect(lastTemplate().map((i) => i.role ?? i.type)).toEqual([
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Select All',
    ]);
    expect(popup).toHaveBeenCalledWith({ window: win });
  });

  it('可用性跟随 editFlags(如只读编辑器:可复制 / 全选,不可剪切 / 粘贴)', () => {
    const { rightClick } = makeWindow();
    rightClick({
      isEditable: true,
      selectionText: 'x',
      editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
    });
    const enabled = Object.fromEntries(
      lastTemplate()
        .filter((i) => i.role)
        .map((i) => [i.role, i.enabled]),
    );
    expect(enabled).toEqual({ cut: false, copy: true, paste: false, selectAll: true });
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('可编辑但四项都不可用 → 不弹', () => {
    const { rightClick } = makeWindow();
    rightClick({ isEditable: true, selectionText: '', editFlags: NONE });
    expect(popup).not.toHaveBeenCalled();
  });

  it('非可编辑、有选中文本 → 只给「复制」', () => {
    const { rightClick } = makeWindow();
    rightClick({
      isEditable: false,
      selectionText: 'hello',
      editFlags: { ...NONE, canCopy: true },
    });
    expect(lastTemplate().map((i) => i.role)).toEqual(['copy']);
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('非可编辑、无选区 → 不弹', () => {
    const { rightClick } = makeWindow();
    rightClick({ isEditable: false, selectionText: '', editFlags: { ...NONE, canCopy: true, canSelectAll: true } });
    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });

  it('文案按当前语言(每次右键时取):切到中文 / 韩文后立即生效', () => {
    const { rightClick } = makeWindow();
    localeRef.current = 'zh';
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual(['剪切', '复制', '粘贴', '全选']);

    localeRef.current = 'ko';
    rightClick({ isEditable: true, selectionText: 'a', editFlags: ALL });
    expect(lastTemplate().map((i) => i.label).filter(Boolean)).toEqual([
      '잘라내기',
      '복사',
      '붙여넣기',
      '모두 선택',
    ]);
  });

  it('main 入口在 browser-window-created(主窗与 popout 子窗统一)为每个窗口挂上', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../../electron/main/index.ts'),
      'utf8',
    );
    const handler = src.slice(src.indexOf("app.on('browser-window-created'"));
    expect(handler.slice(0, handler.indexOf('\n});'))).toContain(
      'installEditContextMenu(win, getMainT)',
    );
  });
});
