import { describe, it, expect, beforeEach } from 'vitest';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';

beforeEach(() => {
  // 每个测试重置 store
  useCommandPaletteStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
  });
});

describe('CommandPalette store', () => {
  it('open() → isOpen=true,query=空,selectedIndex=0', () => {
    useCommandPaletteStore.setState({
      query: 'leftover',
      selectedIndex: 5,
    });
    useCommandPaletteStore.getState().open();
    const s = useCommandPaletteStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.query).toBe('');
    expect(s.selectedIndex).toBe(0);
  });

  it('close() → isOpen=false', () => {
    useCommandPaletteStore.getState().open();
    useCommandPaletteStore.getState().close();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('setQuery 同时把 selectedIndex 复位 0', () => {
    useCommandPaletteStore.setState({ selectedIndex: 3 });
    useCommandPaletteStore.getState().setQuery('foo');
    const s = useCommandPaletteStore.getState();
    expect(s.query).toBe('foo');
    expect(s.selectedIndex).toBe(0);
  });

  it('moveSelection 下移正常', () => {
    useCommandPaletteStore.setState({ selectedIndex: 1 });
    useCommandPaletteStore.getState().moveSelection(1, 5);
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(2);
  });

  it('moveSelection 到末尾后跳头', () => {
    useCommandPaletteStore.setState({ selectedIndex: 4 });
    useCommandPaletteStore.getState().moveSelection(1, 5);
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  it('moveSelection 在 0 上移跳尾', () => {
    useCommandPaletteStore.setState({ selectedIndex: 0 });
    useCommandPaletteStore.getState().moveSelection(-1, 5);
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(4);
  });

  it('max=0(无候选)→ 不动', () => {
    useCommandPaletteStore.setState({ selectedIndex: 0 });
    useCommandPaletteStore.getState().moveSelection(1, 0);
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  // race(R49,R48 孪生):命令集合动态变短(插件 reload/disable / registry 重算)时 selectedIndex
  // 须钳回 [0,len-1],防 Enter 读 filtered[idx]=undefined 命令无法执行 + 高亮悬空。
  describe('clampSelection(R49)', () => {
    it('越界 → 钳到末项', () => {
      useCommandPaletteStore.setState({ selectedIndex: 30 });
      useCommandPaletteStore.getState().clampSelection(5);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(4);
    });

    it('空列表 → 钳到 0', () => {
      useCommandPaletteStore.setState({ selectedIndex: 4 });
      useCommandPaletteStore.getState().clampSelection(0);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
    });

    it('在范围内 → 不变', () => {
      useCommandPaletteStore.setState({ selectedIndex: 2 });
      useCommandPaletteStore.getState().clampSelection(5);
      expect(useCommandPaletteStore.getState().selectedIndex).toBe(2);
    });
  });
});
