// 关窗 / 退出时脏文件确认:renderer 侧脏态计数与「保存」分支的批量保存。见同目录 README.md。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  countDirtyForClose,
  remainingAfterFlush,
  saveDirtyTabsForClose,
} from '../../shell/dock/dirty-close';
import {
  claimAutoSave,
  releaseAutoSave,
  setAutoSaveFailed,
} from '../../panels/Editor/autosave-failures';

const tab = (filePath: string | null, dirty: boolean, id = filePath ?? 'untitled-1') => ({
  id,
  filePath,
  dirty,
});

describe('countDirtyForClose:只统计关窗会丢的脏 tab', () => {
  const owner = {};
  afterEach(() => releaseAutoSave(owner));

  it('无脏 tab → 0', () => {
    expect(countDirtyForClose([tab('/a.ts', false)], true)).toEqual({
      dirty: 0,
      untitled: 0,
      ids: [],
      untitledIds: [],
    });
  });

  it('脏代码文件计入;untitled 草稿计入并单独计数(附带 id 列表)', () => {
    expect(
      countDirtyForClose(
        [tab('/a.ts', true), tab('/b.json', true), tab(null, true), tab('/c.ts', false)],
        true,
      ),
    ).toEqual({ dirty: 3, untitled: 1, ids: ['/a.ts', '/b.json', 'untitled-1'], untitledIds: ['untitled-1'] });
  });

  it('Markdown 自动保存开启时,活动 tab(持有 autosave scheduler)的脏 .md 不计入(关窗 flush 会落盘)', () => {
    claimAutoSave('/a.md', owner);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(0);
  });

  // 复审:非活动 tab 切走时 useAutoSave 已 flush,仍脏即失败或在途;关窗 flush 只持有活动 tab 的 scheduler,
  // 不会重试它 → 一律计入(此前按「失败记录」排除,重命名非活动失败 tab 后记录被清 → 无确认丢失)。
  it('非活动 tab 的脏 .md 一律计入(含被重命名的非活动 tab)', () => {
    claimAutoSave('/a.md', owner);
    expect(
      countDirtyForClose([tab('/a.md', true), tab('/b.md', true), tab('/renamed.md', true)], true),
    ).toMatchObject({ dirty: 2, ids: ['/b.md', '/renamed.md'] });
  });

  it('无活动 autosave scheduler(编辑器未挂载)→ 脏 .md 计入', () => {
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(1);
  });

  it('Markdown 自动保存关闭时脏 .md 计入', () => {
    claimAutoSave('/a.md', owner);
    expect(countDirtyForClose([tab('/a.md', true)], false).dirty).toBe(1);
  });

  // 活动 tab autosave 失败(ENOSPC/EACCES/EDITOR_DISK_CHANGED)后无 pending timer,关窗 flush 不会重试 → 计入。
  it('活动 tab 最近一次 autosave 失败 → 计入;再次 schedule / 成功 → 恢复排除', () => {
    claimAutoSave('/a.md', owner);
    setAutoSaveFailed(owner, true);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(1);
    setAutoSaveFailed(owner, false);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(0);
  });

  // 状态绑定 scheduler 实例:切 tab / 重命名 / 关闭重开都会换实例,旧实例的迟到结果不影响新实例。
  it('旧 scheduler 实例的迟到失败结果被丢弃', () => {
    const old = {};
    claimAutoSave('/a.md', old);
    releaseAutoSave(old);
    claimAutoSave('/a.md', owner);
    setAutoSaveFailed(old, true);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(0);
  });

  it('换实例从「未失败」开始;释放后不再排除', () => {
    const old = {};
    claimAutoSave('/a.md', old);
    setAutoSaveFailed(old, true);
    claimAutoSave('/a.md', owner);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(0);
    releaseAutoSave(old); // 非当前实例:无效
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(0);
    releaseAutoSave(owner);
    expect(countDirtyForClose([tab('/a.md', true)], true).dirty).toBe(1);
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
// untitled 计入 —— 但本轮选了「保存」时用户已被告知的 untitled(按 id)不因它们中止。
describe('remainingAfterFlush:flush 后仍未保存的改动', () => {
  const none = new Set<string>();

  it('全部干净 → null', () => {
    expect(remainingAfterFlush([tab('/a.ts', false), tab('/b.md', false)], none)).toBeNull();
  });

  it('仍脏的 .md(autosave flush 失败)与代码文件都计入,不看 autosave 设置', () => {
    expect(remainingAfterFlush([tab('/a.md', true), tab('/b.ts', true)], none)).toEqual({
      dirty: 2,
      untitled: 0,
      ids: ['/a.md', '/b.ts'],
      untitledIds: [],
    });
  });

  it('未弹框(非保存,放过 0 个)时 untitled 草稿计入', () => {
    expect(remainingAfterFlush([tab(null, true)], none)).toMatchObject({ dirty: 1, untitled: 1 });
  });

  it('「保存」分支只剩已告知的 untitled → null;有路径的仍脏 → 计数含 untitled', () => {
    const told = new Set(['untitled-1']);
    expect(remainingAfterFlush([tab(null, true)], told)).toBeNull();
    expect(remainingAfterFlush([tab(null, true), tab('/a.ts', true)], told)).toMatchObject({
      dirty: 2,
      untitled: 1,
    });
  });

  // 复审:此前按数量放过 → 确认后才新建的 untitled 草稿(同数量替换)被静默丢弃。只放过确认框告知的 id。
  it('「保存」分支 untitled 不在告知的 id 集合里(新建 / 同数量替换)→ 计入 remaining', () => {
    const told = new Set(['untitled-1']);
    expect(
      remainingAfterFlush([tab(null, true, 'untitled-1'), tab(null, true, 'untitled-2')], told),
    ).toMatchObject({ dirty: 2, untitled: 2 });
    expect(remainingAfterFlush([tab(null, true, 'untitled-2')], told)).toMatchObject({
      dirty: 1,
      ids: ['untitled-2'],
    });
  });

  it('告知集合只放过 untitled:同 id 的有路径 tab 不被放过', () => {
    expect(remainingAfterFlush([tab('/a.ts', true)], new Set(['/a.ts']))).toMatchObject({ dirty: 1 });
  });
});
