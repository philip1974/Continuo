import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveFile,
  type EditorFileDeps,
} from '../../panels/Editor/editor-file-actions';
import { createTab, useEditorStore } from '../../stores/editor.store';
import type { IpcResult } from '../../lib/fs/types';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
});

// P1 回归:saveFile 在 line 65 快照 tab(content=S1),await writeFile 期间用户继续
// 键入 → store content=S2/dirty=true。旧 markSaved(id) 读**当前** content=S2 设
// originalContent=S2 + dirty=false → 磁盘 S1、内存 S2、UI 显示已保存 → S2 增量
// 既没落盘又不再触发 autosave,静默丢失。修复:markSaved 收到已写盘快照,仅当
// 当前内容仍等于已写内容时才清 dirty。
describe('49 · saveFile 写盘 await 期间并发编辑不丢 dirty', () => {
  it('写盘期间键入 → 保留 dirty=true,originalContent 推进到已写内容', async () => {
    const tab = createTab('/w/a.md', 'S1');
    useEditorStore.setState({ tabs: [tab], activeTabId: tab.id });

    // writeFile 在 await 期间模拟用户键入 S2
    const writeFile = vi.fn(async (_path: string, content: string) => {
      expect(content).toBe('S1'); // 写盘的是快照 S1,不是后来的 S2
      useEditorStore.getState().updateContent(tab.id, 'S1 + S2');
      return ok(undefined as void);
    });
    const deps: EditorFileDeps = {
      fs: { readFile: vi.fn(async () => ok('')), writeFile },
      store: useEditorStore,
    };

    const r = await saveFile(tab.id, deps);
    expect(r.ok).toBe(true);

    const saved = useEditorStore.getState().tabs.find((t) => t.id === tab.id)!;
    expect(saved.content).toBe('S1 + S2'); // 内存保留并发编辑
    expect(saved.originalContent).toBe('S1'); // 磁盘已写 = S1
    expect(saved.dirty).toBe(true); // 关键:不被静默清掉,后续 autosave 会再写
  });

  it('正常路径:无并发编辑 → dirty=false,originalContent ← 已写内容', async () => {
    const tab = createTab('/w/b.md', 'hello');
    // 标脏一下,模拟用户编辑后保存
    useEditorStore.setState({ tabs: [tab], activeTabId: tab.id });
    useEditorStore.getState().updateContent(tab.id, 'hello world');

    const deps: EditorFileDeps = {
      fs: {
        readFile: vi.fn(async () => ok('')),
        writeFile: vi.fn(async () => ok(undefined as void)),
      },
      store: useEditorStore,
    };

    const r = await saveFile(tab.id, deps);
    expect(r.ok).toBe(true);

    const saved = useEditorStore.getState().tabs.find((t) => t.id === tab.id)!;
    expect(saved.content).toBe('hello world');
    expect(saved.originalContent).toBe('hello world');
    expect(saved.dirty).toBe(false);
  });
});
