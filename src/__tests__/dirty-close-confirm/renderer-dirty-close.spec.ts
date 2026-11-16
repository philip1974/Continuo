// 关窗 / 退出时脏文件确认:renderer 侧脏态计数与「保存」分支的批量保存。见同目录 README.md。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  countDirtyForClose,
  remainingAfterFlush,
  saveDirtyTabsForClose,
} from '../../shell/dock/dirty-close';
import {
  getAutoSaveRecordEpoch,
  isAutoSaveFailed,
  setAutoSaveFailed,
} from '../../panels/Editor/autosave-failures';
import { createTab, useEditorStore } from '../../stores/editor.store';

const tab = (filePath: string | null, dirty: boolean, id = filePath ?? 'untitled-1') => ({
  id,
  filePath,
  dirty,
});

describe('countDirtyForClose:只统计关窗会丢的脏 tab', () => {
  it('无脏 tab → 0', () => {
    expect(countDirtyForClose([tab('/a.ts', false)], true)).toEqual({ dirty: 0, untitled: 0 });
  });

  it('脏代码文件计入;untitled 草稿计入并单独计数', () => {
    expect(
      countDirtyForClose(
        [tab('/a.ts', true), tab('/b.json', true), tab(null, true), tab('/c.ts', false)],
        true,
      ),
    ).toEqual({ dirty: 3, untitled: 1 });
  });

  it('Markdown 自动保存开启时脏 .md 不计入(关窗 flush 会自动落盘)', () => {
    expect(countDirtyForClose([tab('/a.md', true), tab('/b.markdown', true)], true)).toEqual({
      dirty: 0,
      untitled: 0,
    });
  });

  it('Markdown 自动保存关闭时脏 .md 计入', () => {
    expect(countDirtyForClose([tab('/a.md', true)], false)).toEqual({ dirty: 1, untitled: 0 });
  });

  // 复审:autosave 失败(ENOSPC/EACCES/EDITOR_DISK_CHANGED)后 tab 仍脏、scheduler 无 pending timer,
  // 关窗 flush 不会重试 → 不计入就会无确认丢失。失败态的脏 .md 必须计入;成功后恢复排除。
  describe('autosave 失败态', () => {
    afterEach(() => setAutoSaveFailed('/a.md', false));

    it('最近一次 autosave 失败的脏 .md 计入(其它脏 .md 仍排除)', () => {
      setAutoSaveFailed('/a.md', true);
      expect(countDirtyForClose([tab('/a.md', true), tab('/b.md', true)], true)).toEqual({
        dirty: 1,
        untitled: 0,
      });
    });

    it('autosave 再次成功 → 恢复排除', () => {
      setAutoSaveFailed('/a.md', true);
      setAutoSaveFailed('/a.md', false);
      expect(countDirtyForClose([tab('/a.md', true)], true)).toEqual({ dirty: 0, untitled: 0 });
    });
  });
});

describe('saveDirtyTabsForClose:「保存」分支保存所有有路径的脏 tab', () => {
  it('跳过 clean 与 untitled,失败数 0', async () => {
    const saveTab = vi.fn(async (_id: string) => ({ ok: true as const }));
    const r = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.md', true), tab(null, true), tab('/c.ts', false)],
      saveTab,
      () => [],
    );
    expect(r).toEqual({ failed: 0, diskChanged: 0 });
    expect(saveTab.mock.calls.map((c) => c[0]).sort()).toEqual(['/a.ts', '/b.md']);
  });

  it('保存返回 ok:false 或抛异常 → 计为失败;EDITOR_DISK_CHANGED 单独计数', async () => {
    const saveTab = vi.fn(async (id: string) => {
      if (id === '/b.ts') throw new Error('disk full');
      if (id === '/c.ts') return { ok: false as const, code: 'FS_DENIED' };
      if (id === '/d.ts') return { ok: false as const, code: 'EDITOR_DISK_CHANGED' };
      return { ok: true as const };
    });
    const r = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.ts', true), tab('/c.ts', true), tab('/d.ts', true)],
      saveTab,
      () => [],
    );
    expect(r).toEqual({ failed: 3, diskChanged: 1 });
  });

  // 复审:保存期间用户继续输入 → saveFile 返回 ok 但 tab 仍脏(markSaved 保留 dirty)。只看返回值
  // 会报成功并退出,丢掉新输入;保存完成后复查当前 tab,仍脏视为保存未完成。
  it('保存 ok 但完成后 tab 仍 dirty(期间继续输入)→ 计为失败', async () => {
    const saveTab = vi.fn(async (_id: string) => ({ ok: true as const }));
    const r = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.ts', true)],
      saveTab,
      () => [tab('/a.ts', true), tab('/b.ts', false)],
    );
    expect(r).toEqual({ failed: 1, diskChanged: 0 });
  });
});

// 统一规则:全部 flush(含 markdown autosave flush)完成后最终脏检查。autosave 已 flush 过,仍脏的 .md 也算;
// untitled 计入 —— 但本轮选了「保存」时用户已被告知 untitled 会被丢弃,不因它们中止。
describe('remainingAfterFlush:flush 后仍未保存的改动', () => {
  it('全部干净 → null', () => {
    expect(remainingAfterFlush([tab('/a.ts', false), tab('/b.md', false)], 0)).toBeNull();
  });

  it('仍脏的 .md(autosave flush 失败)与代码文件都计入,不看 autosave 设置', () => {
    expect(remainingAfterFlush([tab('/a.md', true), tab('/b.ts', true)], 0)).toEqual({
      dirty: 2,
      untitled: 0,
    });
  });

  it('未弹框(非保存,放过 0 个)时 untitled 草稿计入', () => {
    expect(remainingAfterFlush([tab(null, true)], 0)).toEqual({ dirty: 1, untitled: 1 });
  });

  it('「保存」分支只剩已告知的 untitled → null;有路径的仍脏 → 计数含 untitled', () => {
    expect(remainingAfterFlush([tab(null, true)], 1)).toBeNull();
    expect(remainingAfterFlush([tab(null, true), tab('/a.ts', true)], 1)).toEqual({
      dirty: 2,
      untitled: 1,
    });
  });

  // 复审:此前「保存」无条件放过所有 untitled → 确认后才新建的 untitled 草稿被静默丢弃。只放过确认框告知的数。
  it('「保存」分支 untitled 超过确认框告知的数 → 计入 remaining', () => {
    expect(
      remainingAfterFlush([tab(null, true, 'untitled-1'), tab(null, true, 'untitled-2')], 1),
    ).toEqual({ dirty: 2, untitled: 2 });
  });
});

// 复审(f):失败记录按 tab id(= 文件路径)存。不随 tab 关闭 / 删除 / 重命名清理 → 重开同路径继承旧失败态、
// 集合只增不减。tab 从 editor store 消失即清除;旧 tab 的迟到 autosave 结果(带开始时的 epoch)不写入新实例。
describe('autosave 失败记录随 tab 生命周期清理', () => {
  // autosave 只对脏 tab 发生(干净 tab 的失败不记录,见下一组)。
  const open = (p: string) => {
    useEditorStore.getState().openTab(createTab(p, 'x'));
    useEditorStore.getState().updateContent(p, 'y');
  };
  afterEach(() => useEditorStore.setState({ tabs: [], activeTabId: null }));

  it('closeTab → 清除该 tab 的失败记录', () => {
    open('/w/a.md');
    setAutoSaveFailed('/w/a.md', true);
    useEditorStore.getState().closeTab('/w/a.md');
    expect(isAutoSaveFailed('/w/a.md')).toBe(false);
  });

  // removePath 只自动关闭干净 tab,而干净 tab 的记录已按「变干净即清除」规则清掉(见下一组)。
  it('renamePath(旧 id 消失)→ 清除', () => {
    open('/w/c.md');
    setAutoSaveFailed('/w/c.md', true);
    useEditorStore.getState().renamePath('/w/c.md', '/w/d.md');
    expect(isAutoSaveFailed('/w/c.md')).toBe(false);
  });

  it('仍打开的 tab 记录保留', () => {
    open('/w/e.md');
    open('/w/f.md');
    setAutoSaveFailed('/w/e.md', true);
    useEditorStore.getState().closeTab('/w/f.md');
    expect(isAutoSaveFailed('/w/e.md')).toBe(true);
    setAutoSaveFailed('/w/e.md', false);
  });

  it('关闭后重开同路径:旧实例的迟到失败结果不写入新实例', () => {
    open('/w/g.md');
    const epoch = getAutoSaveRecordEpoch('/w/g.md'); // 旧实例 autosave 开始时取
    useEditorStore.getState().closeTab('/w/g.md');
    open('/w/g.md');
    setAutoSaveFailed('/w/g.md', true, epoch); // 旧保存迟到失败
    expect(isAutoSaveFailed('/w/g.md')).toBe(false);
    // 新实例自己的结果照常记录
    setAutoSaveFailed('/w/g.md', true, getAutoSaveRecordEpoch('/w/g.md'));
    expect(isAutoSaveFailed('/w/g.md')).toBe(true);
  });

  // 复审:此前全局 epoch —— 关闭 / 重命名任意兄弟 tab 都会丢弃本 tab 在途 autosave 的结果。改为按 tab 代际。
  it('在途 autosave 期间关闭 / 重命名兄弟 tab:本 tab 的迟到失败结果照常记录', () => {
    open('/w/h.md');
    open('/w/i.md');
    open('/w/j.md');
    const epoch = getAutoSaveRecordEpoch('/w/h.md');
    useEditorStore.getState().closeTab('/w/i.md');
    useEditorStore.getState().renamePath('/w/j.md', '/w/k.md');
    setAutoSaveFailed('/w/h.md', true, epoch);
    expect(isAutoSaveFailed('/w/h.md')).toBe(true);
    setAutoSaveFailed('/w/h.md', false);
  });
});

// 复审:显式保存成功(Cmd+S / 冲突覆盖)不清失败记录 → 下次编辑即被当作「autosave 失败」误触发关窗确认。
describe('tab 变干净即清除 autosave 失败记录', () => {
  const openDirtyMd = (p: string) => {
    useEditorStore.getState().openTab(createTab(p, 'x'));
    useEditorStore.getState().updateContent(p, 'y');
  };
  afterEach(() => useEditorStore.setState({ tabs: [], activeTabId: null }));

  it('失败后显式保存成功(markSaved → clean)→ 清除;再次编辑不再算失败', () => {
    openDirtyMd('/w/m.md');
    setAutoSaveFailed('/w/m.md', true);
    useEditorStore.getState().markSaved('/w/m.md');
    expect(isAutoSaveFailed('/w/m.md')).toBe(false);
    useEditorStore.getState().updateContent('/w/m.md', 'z');
    expect(isAutoSaveFailed('/w/m.md')).toBe(false);
  });

  it('显式保存后在途 autosave 才迟到失败(tab 已干净)→ 不记录', () => {
    openDirtyMd('/w/n.md');
    const epoch = getAutoSaveRecordEpoch('/w/n.md');
    useEditorStore.getState().markSaved('/w/n.md');
    setAutoSaveFailed('/w/n.md', true, epoch);
    expect(isAutoSaveFailed('/w/n.md')).toBe(false);
  });
});
