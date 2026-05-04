import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
});

describe('workspace.store', () => {
  it('初态:root null,recentRoots 空', () => {
    const s = useWorkspaceStore.getState();
    expect(s.root).toBeNull();
    expect(s.recentRoots).toEqual([]);
  });

  it('setRoot(/a):root 与 recentRoots 同步', () => {
    useWorkspaceStore.getState().setRoot('/a');
    const s = useWorkspaceStore.getState();
    expect(s.root).toBe('/a');
    expect(s.recentRoots).toEqual(['/a']);
  });

  it('setRoot 切到新路径:LRU 在前', () => {
    useWorkspaceStore.getState().setRoot('/a');
    useWorkspaceStore.getState().setRoot('/b');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/b', '/a']);
  });

  it('setRoot 重复同 path:不重复 LRU', () => {
    useWorkspaceStore.getState().setRoot('/a');
    useWorkspaceStore.getState().setRoot('/a');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/a']);
  });

  it('setRoot 已在 recent 中的旧 path:提到最前', () => {
    useWorkspaceStore.getState().setRoot('/a');
    useWorkspaceStore.getState().setRoot('/b');
    useWorkspaceStore.getState().setRoot('/a');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/a', '/b']);
  });

  it('LRU 上限 5,超出截断', () => {
    const set = useWorkspaceStore.getState().setRoot;
    set('/1'); set('/2'); set('/3'); set('/4'); set('/5'); set('/6');
    expect(useWorkspaceStore.getState().recentRoots).toEqual([
      '/6', '/5', '/4', '/3', '/2',
    ]);
  });

  it('setRoot(null):root 置空,recentRoots 不动', () => {
    useWorkspaceStore.getState().setRoot('/a');
    useWorkspaceStore.getState().setRoot(null);
    const s = useWorkspaceStore.getState();
    expect(s.root).toBeNull();
    expect(s.recentRoots).toEqual(['/a']);
  });
});
