// 关窗 / 退出时脏文件确认:renderer 侧脏态计数与「保存」分支的批量保存。见同目录 README.md。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  countDirtyForClose,
  saveDirtyTabsForClose,
} from '../../shell/dock/dirty-close';
import { setAutoSaveFailed } from '../../panels/Editor/autosave-failures';

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
