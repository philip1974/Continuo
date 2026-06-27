import { describe, it, expect, beforeEach } from 'vitest';
import { useExplorerStore } from '../../stores/explorer.store';
import {
  PATH_ARRAY_MAX,
  PATH_STR_MAX,
} from '../../../electron/shared/explorer-persistence-schema';

beforeEach(() => {
  // 复位到初态(避免 spec 间互相污染)
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
});

describe('explorer.store · 初态', () => {
  it('字段默认值', () => {
    const s = useExplorerStore.getState();
    expect(s.expandedPaths.size).toBe(0);
    expect(s.sort).toEqual({ by: 'name', reverse: false });
  });
});

describe('explorer.store · toggleExpand', () => {
  it('未展开 → 加入 expandedPaths', () => {
    useExplorerStore.getState().toggleExpand('/a');
    expect(useExplorerStore.getState().expandedPaths.has('/a')).toBe(true);
  });

  it('已展开 → 移除', () => {
    useExplorerStore.getState().toggleExpand('/a');
    useExplorerStore.getState().toggleExpand('/a');
    expect(useExplorerStore.getState().expandedPaths.has('/a')).toBe(false);
  });

  it('多个互不影响', () => {
    useExplorerStore.getState().toggleExpand('/a');
    useExplorerStore.getState().toggleExpand('/b');
    const s = useExplorerStore.getState();
    expect(s.expandedPaths.has('/a')).toBe(true);
    expect(s.expandedPaths.has('/b')).toBe(true);
  });

  it('返回新 Set 引用(防 React 误判 unchanged)', () => {
    const before = useExplorerStore.getState().expandedPaths;
    useExplorerStore.getState().toggleExpand('/a');
    const after = useExplorerStore.getState().expandedPaths;
    expect(before).not.toBe(after);
  });
});

describe('explorer.store · setExpandedPaths', () => {
  it('整体替换 expandedPaths,并返回新 Set 引用', () => {
    useExplorerStore.getState().toggleExpand('/old');
    const before = useExplorerStore.getState().expandedPaths;

    useExplorerStore.getState().setExpandedPaths(['/work', '/work/src']);

    const after = useExplorerStore.getState().expandedPaths;
    expect(after).toEqual(new Set(['/work', '/work/src']));
    expect(after).not.toBe(before);
  });

  // 边界(E277,E276 同族 / 运行时状态守持久化契约):expandedPaths 不得超持久化 schema(PATH_ARRAY_MAX 条
  // + 单条 ≤ PATH_STR_MAX),否则 explorer:write 拒整份 → 全 explorer 持久化失败。
  it('E277 setExpandedPaths 超 PATH_ARRAY_MAX → 截断到上限', () => {
    const many = Array.from({ length: PATH_ARRAY_MAX + 50 }, (_, i) => `/p${i}`);
    useExplorerStore.getState().setExpandedPaths(many);
    expect(useExplorerStore.getState().expandedPaths.size).toBe(PATH_ARRAY_MAX);
  });

  it('E277 setExpandedPaths 过滤超长 path', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    useExplorerStore.getState().setExpandedPaths(['/ok', longPath]);
    const s = useExplorerStore.getState().expandedPaths;
    expect(s.has('/ok')).toBe(true);
    expect(s.has(longPath)).toBe(false);
  });

  it('E277 toggleExpand 达 PATH_ARRAY_MAX 后新 path 拒加;超长 path 拒加', () => {
    const full = new Set(
      Array.from({ length: PATH_ARRAY_MAX }, (_, i) => `/p${i}`),
    );
    useExplorerStore.setState({ expandedPaths: full });
    useExplorerStore.getState().toggleExpand('/overflow');
    expect(useExplorerStore.getState().expandedPaths.size).toBe(PATH_ARRAY_MAX);
    expect(useExplorerStore.getState().expandedPaths.has('/overflow')).toBe(false);

    useExplorerStore.setState({ expandedPaths: new Set() });
    useExplorerStore.getState().toggleExpand('/' + 'y'.repeat(PATH_STR_MAX));
    expect(useExplorerStore.getState().expandedPaths.size).toBe(0);
  });
});

describe('explorer.store · setSort', () => {
  it('setSort 替换 sort', () => {
    useExplorerStore.getState().setSort({ by: 'mtime', reverse: true });
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
  });
});
