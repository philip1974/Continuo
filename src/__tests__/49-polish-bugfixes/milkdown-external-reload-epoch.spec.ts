// topic 49 第十轮 · P1-Z:外部修改 markdown 文件后 Milkdown 视图能拿到新内容。
//
// 根因:MilkdownEditor 的 defaultValue 只在 mount 时读,视图靠 EditorPanel 的
// key remount 刷新。旧 key=`${id}-${effective}` 不含内容,外部进程改文件时
// useExternalFileSync→reloadFromDisk 更新了 store content,但 id/effective 都没变
// → Milkdown 不 remount,仍显示旧内容。用户随后编辑的序列化基线是旧内容,保存时
// **静默覆盖磁盘上的外部新版本**(数据丢失)。CodeEditor 有 [value] 同步 effect,
// Milkdown 没有。
//
// 修复:tab 加 reloadEpoch,仅 reloadFromDisk 递增(用户输入/保存不动),并入
// Milkdown key → 外部改动时 remount 拿新内容,正常编辑不会每按键 remount。

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, createTab } from '../../stores/editor.store';

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

describe('topic49 P1-Z · 外部重载 epoch', () => {
  it('reloadFromDisk(内容确实变了)→ reloadEpoch 递增', () => {
    const tab = createTab('/a.md', 'old');
    useEditorStore.setState({ tabs: [tab], activeTabId: '/a.md' });
    expect(useEditorStore.getState().tabs[0]!.reloadEpoch ?? 0).toBe(0);

    useEditorStore.getState().reloadFromDisk('/a.md', 'new-external');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('new-external');
    expect(t.reloadEpoch).toBe(1);

    useEditorStore.getState().reloadFromDisk('/a.md', 'newer-external');
    expect(useEditorStore.getState().tabs[0]!.reloadEpoch).toBe(2);
  });

  it('用户输入(updateContent)不动 reloadEpoch(避免每按键 remount)', () => {
    const tab = createTab('/a.md', 'old');
    useEditorStore.setState({ tabs: [tab], activeTabId: '/a.md' });
    useEditorStore.getState().updateContent('/a.md', 'typed-1');
    useEditorStore.getState().updateContent('/a.md', 'typed-2');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('typed-2');
    expect(t.reloadEpoch ?? 0).toBe(0); // 没动
  });

  it('保存(markSaved)不动 reloadEpoch', () => {
    const tab = createTab('/a.md', 'old');
    useEditorStore.setState({ tabs: [tab], activeTabId: '/a.md' });
    useEditorStore.getState().updateContent('/a.md', 'edited');
    useEditorStore.getState().markSaved('/a.md', 'edited');
    expect(useEditorStore.getState().tabs[0]!.reloadEpoch ?? 0).toBe(0);
  });

  it('dirty tab 的 reloadFromDisk 被跳过 → epoch 不变(保护用户改动)', () => {
    const tab = createTab('/a.md', 'old');
    useEditorStore.setState({ tabs: [tab], activeTabId: '/a.md' });
    useEditorStore.getState().updateContent('/a.md', 'user-edit'); // 变 dirty
    useEditorStore.getState().reloadFromDisk('/a.md', 'external-change');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('user-edit'); // 用户改动保留
    expect(t.reloadEpoch ?? 0).toBe(0); // 未重载,epoch 不动
  });

  it('内容未变的 reloadFromDisk(stat 触发但实际没改)→ epoch 不变', () => {
    const tab = createTab('/a.md', 'same');
    useEditorStore.setState({ tabs: [tab], activeTabId: '/a.md' });
    useEditorStore.getState().reloadFromDisk('/a.md', 'same');
    expect(useEditorStore.getState().tabs[0]!.reloadEpoch ?? 0).toBe(0);
  });
});
