// BDD:拖到编辑区以外的地方(窗口级 drop)—— 普通文件也打开(活动编辑器组),多文件全部打开;编辑器已认领(插入 / 打开)的不再
// 打开;有文件夹 → 不当文件打开(窗口级照旧打开为工作区,见 window-drop)。见同目录 README。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: { window: { getPathForFile: (f: File) => `/outside/${f.name}` } } }));

import { captureDroppedRegularFiles, claimDroppedFiles, unclaimedDroppedFiles } from '@/lib/window-drop';
import { openOsDroppedFiles } from '@/panels/Editor/os-file-drop';

const file = (name: string) => new File(['x'], name);

function drop(files: File[], items?: unknown[]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      files,
      items: items ?? files.map(() => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) })),
      getData: () => '',
    },
  });
  return event;
}

describe('窗口级:打开未认领的文件', () => {
  it('普通文件(单个 / 多个)→ 全部打开,不指定组(= 活动编辑器组)', () => {
    const open = vi.fn();
    expect(openOsDroppedFiles(drop([file('a.txt'), file('b.png')]), undefined, open)).toBe(true);
    expect(open).toHaveBeenCalledWith(['/outside/a.txt', '/outside/b.png'], undefined);
  });

  it('编辑器面板已经打开 / 编辑器已插入的(认领过)→ 不再打开;同一事件再处理一次也不重复打开', () => {
    const open = vi.fn();
    const a = file('a.txt');
    const b = file('b.txt');
    const e = drop([a, b]);
    claimDroppedFiles(e, [a]);
    openOsDroppedFiles(e, undefined, open);
    expect(open).toHaveBeenCalledWith(['/outside/b.txt'], undefined);
    expect(openOsDroppedFiles(e, undefined, open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(unclaimedDroppedFiles(e, [a, b])).toEqual([]);
  });

  it('有文件夹 → 不打开任何文件(交给「打开为工作区」)', () => {
    const open = vi.fn();
    const e = drop([file('dir'), file('a.txt')], [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
    ]);
    expect(openOsDroppedFiles(e, undefined, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('不是文件拖放(文字 / 资源管理器内部拖动)→ 不处理', () => {
    const open = vi.fn();
    const e = new Event('drop') as DragEvent;
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['text/plain'], files: [], items: [], getData: () => 'x' } });
    expect(openOsDroppedFiles(e, undefined, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('captureDroppedRegularFiles', () => {
  it('可判定:只返回非目录文件;hadDirectory 标记', () => {
    const d = file('dir');
    const a = file('a');
    const r = captureDroppedRegularFiles(
      { files: [d, a], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }, { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }] },
      10,
    );
    expect(r).toEqual({ files: [a], hadDirectory: true });
  });

  it('无法判定(合成拖放没有 entry)→ 全部当文件,hadDirectory=false', () => {
    const a = file('a');
    expect(captureDroppedRegularFiles({ files: [a], items: [{ kind: 'file', webkitGetAsEntry: () => null }] }, 10)).toEqual({
      files: [a],
      hadDirectory: false,
    });
  });
});
