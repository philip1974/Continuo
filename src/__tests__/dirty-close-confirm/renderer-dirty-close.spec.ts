// 关窗 / 退出时脏文件确认:renderer 侧脏态计数与「保存」分支的批量保存。见同目录 README.md。

import { describe, it, expect, vi } from 'vitest';
import {
  countDirtyForClose,
  saveDirtyTabsForClose,
} from '../../shell/dock/dirty-close';

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
});

describe('saveDirtyTabsForClose:「保存」分支保存所有有路径的脏 tab', () => {
  it('跳过 clean 与 untitled,返回失败数 0', async () => {
    const saveTab = vi.fn(async (_id: string) => ({ ok: true as const }));
    const failed = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.md', true), tab(null, true), tab('/c.ts', false)],
      saveTab,
    );
    expect(failed).toBe(0);
    expect(saveTab.mock.calls.map((c) => c[0]).sort()).toEqual(['/a.ts', '/b.md']);
  });

  it('保存返回 ok:false 或抛异常 → 计为失败', async () => {
    const saveTab = vi.fn(async (id: string) => {
      if (id === '/b.ts') throw new Error('disk full');
      if (id === '/c.ts') return { ok: false as const };
      return { ok: true as const };
    });
    const failed = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.ts', true), tab('/c.ts', true)],
      saveTab,
    );
    expect(failed).toBe(2);
  });
});
