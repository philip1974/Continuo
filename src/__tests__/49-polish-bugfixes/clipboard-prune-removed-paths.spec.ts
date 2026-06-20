// P2 UI 陈旧态回归(第八 session R2):Explorer in-app 剪贴板(cut/copy)此前只在
// cut-paste 全部成功时 clear,是唯一的清除路径。剪切文件 A 后,若 A 被**删除/改名/
// 拖移走**,剪贴板仍引用旧路径 A:
//   1) FileRow hasClipboard 仍 true → 右键 Paste 菜单仍可点,粘贴时对不存在的 A 做
//      fs.move 报错;
//   2) isCutMarked(kind==='cut' && paths.includes(path))→ 若之后在同路径 A 新建文件,
//      该新文件被误灰显为「待粘贴」。
//
// 根因:set 只在 onCut/onCopy,clear 只在 onPaste 全成功 —— 删除(onTrash)/改名
// (onRename)/移动(onDropItems/root-drop)这些使源路径失效的兄弟入口都没剪除剪贴板。
// 属本仓最高频「派生标记离开状态漏清 = UI 陈旧态」+「清理建在一入口漏平行兄弟入口」族。
//
// 修复:store 加 prune(removedPaths)(精确等于或目录前缀匹配,对齐 editor.store
// getStateAfterRemovingPath),并在 onTrash/onRename/onDropItems/root-drop 四个失效点
// 调用。本 spec 锁 prune 的语义;四个调用点接入由 FolderTree 集成保证。
import { describe, it, expect, beforeEach } from 'vitest';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

beforeEach(() => {
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});

describe('49 第八 session · clipboard prune 剪除失效源路径', () => {
  it('删除被 cut 的文件 → 从剪贴板剪除', () => {
    useExplorerClipboardStore.getState().set('cut', ['/ws/a.ts', '/ws/b.ts']);
    useExplorerClipboardStore.getState().prune(['/ws/a.ts']);
    const s = useExplorerClipboardStore.getState();
    expect(s.kind).toBe('cut');
    expect([...s.paths]).toEqual(['/ws/b.ts']);
  });

  it('剪除最后一项 → 一并清掉 kind(剪空)', () => {
    useExplorerClipboardStore.getState().set('cut', ['/ws/a.ts']);
    useExplorerClipboardStore.getState().prune(['/ws/a.ts']);
    const s = useExplorerClipboardStore.getState();
    expect(s.kind).toBeNull();
    expect([...s.paths]).toEqual([]);
  });

  it('删除目录 → 剪除其下所有子路径(目录前缀匹配)', () => {
    useExplorerClipboardStore
      .getState()
      .set('cut', ['/ws/dir/x.ts', '/ws/dir/sub/y.ts', '/ws/keep.ts']);
    useExplorerClipboardStore.getState().prune(['/ws/dir']);
    expect([...useExplorerClipboardStore.getState().paths]).toEqual(['/ws/keep.ts']);
  });

  it('前缀但非目录边界的同名兄弟不误删(/ws/dir2 不被 /ws/dir 命中)', () => {
    useExplorerClipboardStore.getState().set('copy', ['/ws/dir2/z.ts']);
    useExplorerClipboardStore.getState().prune(['/ws/dir']);
    expect([...useExplorerClipboardStore.getState().paths]).toEqual(['/ws/dir2/z.ts']);
  });

  it('Windows 反斜杠目录前缀也匹配', () => {
    useExplorerClipboardStore
      .getState()
      .set('cut', ['C:\\ws\\dir\\x.ts', 'C:\\ws\\keep.ts']);
    useExplorerClipboardStore.getState().prune(['C:\\ws\\dir']);
    expect([...useExplorerClipboardStore.getState().paths]).toEqual(['C:\\ws\\keep.ts']);
  });

  it('无命中 → 返回同一引用(免重渲)', () => {
    useExplorerClipboardStore.getState().set('cut', ['/ws/a.ts']);
    const before = useExplorerClipboardStore.getState().paths;
    useExplorerClipboardStore.getState().prune(['/ws/zzz.ts']);
    expect(useExplorerClipboardStore.getState().paths).toBe(before);
  });

  it('空剪贴板 prune → no-op', () => {
    const before = useExplorerClipboardStore.getState();
    useExplorerClipboardStore.getState().prune(['/ws/a.ts']);
    expect(useExplorerClipboardStore.getState()).toBe(before);
  });

  it('copy 类型同样被剪除(改名/移动后旧路径失效)', () => {
    useExplorerClipboardStore.getState().set('copy', ['/ws/old.ts', '/ws/c.ts']);
    useExplorerClipboardStore.getState().prune(['/ws/old.ts']);
    const s = useExplorerClipboardStore.getState();
    expect(s.kind).toBe('copy');
    expect([...s.paths]).toEqual(['/ws/c.ts']);
  });
});
