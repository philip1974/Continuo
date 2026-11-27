// 关窗 / 退出时脏文件确认:renderer 侧脏态计数与「保存」分支的批量保存。见同目录 README.md。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  countDirtyForClose,
  remainingAfterDiscard,
  remainingAfterFlush,
  SAVE_FOR_CLOSE_CONCURRENCY,
  saveDirtyTabsForClose,
  saveForCloseFailureMessage,
} from '../../shell/dock/dirty-close';
import { setLocale, t } from '../../i18n';
import { createTab, useEditorStore } from '../../stores/editor.store';
import {
  claimAutoSave,
  releaseAutoSave,
  setAutoSaveFailed,
} from '../../panels/Editor/autosave-failures';
import { DEFAULT_AUTO_SAVE_SETTINGS } from '../../panels/Editor/auto-save-config';

const tab = (filePath: string, dirty: boolean, id = filePath, dirtyGen?: number) => ({
  id,
  filePath,
  dirty,
  ...(dirtyGen === undefined ? {} : { dirtyGen }),
});


const noopFlush = async (): Promise<void> => {};
describe('countDirtyForClose:只统计关窗会丢的脏 tab', () => {
  const owner = {};
  afterEach(() => releaseAutoSave(owner));

  it('无脏 tab → 0', () => {
    expect(countDirtyForClose([tab('/a.ts', false)], DEFAULT_AUTO_SAVE_SETTINGS)).toEqual({ dirty: 0, ids: [] });
  });

  it('脏代码文件计入(附带 id 列表)', () => {
    expect(
      countDirtyForClose([tab('/a.ts', true), tab('/b.json', true), tab('/c.ts', false)], DEFAULT_AUTO_SAVE_SETTINGS),
    ).toEqual({ dirty: 2, ids: ['/a.ts#0', '/b.json#0'] });
  });

  it('Markdown 自动保存开启时,活动 tab(持有 autosave scheduler)的脏 .md 不计入(关窗 flush 会落盘)', () => {
    claimAutoSave('/a.md', owner, noopFlush);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(0);
  });

  // 终审 P1:被排除的脏 .md 单独上报为 pendingAutoSave(身份同 ids)。main 据此判断:flush 超时(网络卷读盘挂起等)
  // 时这些改动尚未落盘,不能放行关闭;没有此类 .md 时不带该字段(超时照常放行,renderer 卡死也能关窗)。
  it('被排除的活动 tab 脏 .md 进入 pendingAutoSave;无此类 tab 时不带该字段', () => {
    claimAutoSave('/a.md', owner, noopFlush);
    expect(countDirtyForClose([tab('/a.md', true, '/a.md', 3), tab('/b.ts', true)], DEFAULT_AUTO_SAVE_SETTINGS)).toEqual({
      dirty: 1,
      ids: ['/b.ts#0'],
      pendingAutoSave: ['/a.md#3'],
    });
    expect(countDirtyForClose([tab('/a.md', true)], null)).not.toHaveProperty('pendingAutoSave');
    expect(countDirtyForClose([tab('/a.md', false)], DEFAULT_AUTO_SAVE_SETTINGS)).not.toHaveProperty('pendingAutoSave');
  });

  // 复审:非活动 tab 切走时 useAutoSave 已 flush,仍脏即失败或在途;关窗 flush 只持有活动 tab 的 scheduler,
  // 不会重试它 → 一律计入(此前按「失败记录」排除,重命名非活动失败 tab 后记录被清 → 无确认丢失)。
  it('非活动 tab 的脏 .md 一律计入(含被重命名的非活动 tab)', () => {
    claimAutoSave('/a.md', owner, noopFlush);
    expect(
      countDirtyForClose([tab('/a.md', true), tab('/b.md', true), tab('/renamed.md', true)], DEFAULT_AUTO_SAVE_SETTINGS),
    ).toMatchObject({ dirty: 2, ids: ['/b.md#0', '/renamed.md#0'] });
  });

  it('无活动 autosave scheduler(编辑器未挂载)→ 脏 .md 计入', () => {
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(1);
  });

  it('Markdown 自动保存关闭时脏 .md 计入', () => {
    claimAutoSave('/a.md', owner, noopFlush);
    expect(countDirtyForClose([tab('/a.md', true)], null).dirty).toBe(1);
  });

  // 活动 tab autosave 失败(ENOSPC/EACCES/EDITOR_DISK_CHANGED)后无 pending timer,关窗 flush 不会重试 → 计入。
  it('活动 tab 最近一次 autosave 失败 → 计入;再次 schedule / 成功 → 恢复排除', () => {
    claimAutoSave('/a.md', owner, noopFlush);
    setAutoSaveFailed(owner, true);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(1);
    setAutoSaveFailed(owner, false);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(0);
  });

  // 状态绑定 scheduler 实例:切 tab / 重命名 / 关闭重开都会换实例,旧实例的迟到结果不影响新实例。
  it('旧 scheduler 实例的迟到失败结果被丢弃', () => {
    const old = {};
    claimAutoSave('/a.md', old, noopFlush);
    releaseAutoSave(old);
    claimAutoSave('/a.md', owner, noopFlush);
    setAutoSaveFailed(old, true);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(0);
  });

  it('换实例从「未失败」开始;释放后不再排除', () => {
    const old = {};
    claimAutoSave('/a.md', old, noopFlush);
    setAutoSaveFailed(old, true);
    claimAutoSave('/a.md', owner, noopFlush);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(0);
    releaseAutoSave(old); // 非当前实例:无效
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(0);
    releaseAutoSave(owner);
    expect(countDirtyForClose([tab('/a.md', true)], DEFAULT_AUTO_SAVE_SETTINGS).dirty).toBe(1);
  });
});

describe('saveDirtyTabsForClose:「保存」分支保存所有脏 tab', () => {
  it('跳过 clean,失败数 0', async () => {
    const saveTab = vi.fn(async (_id: string) => ({ ok: true as const }));
    const r = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.md', true), tab('/c.ts', false)],
      saveTab,
      () => [],
    );
    expect(r).toEqual({ failed: 0, diskChanged: 0, readonly: 0, untitled: 0, failedPaths: [] });
    expect(saveTab.mock.calls.map((c) => c[0]).sort()).toEqual(['/a.ts', '/b.md']);
  });

  it('保存返回 ok:false 或抛异常 → 计为失败;EDITOR_DISK_CHANGED / FS_READONLY 单独计数;按输入顺序列出失败文件', async () => {
    const saveTab = vi.fn(async (id: string) => {
      if (id === '/b.ts') throw new Error('disk full');
      if (id === '/c.ts') return { ok: false as const, code: 'FS_DENIED' };
      if (id === '/d.ts') return { ok: false as const, code: 'EDITOR_DISK_CHANGED' };
      if (id === '/e.ts') return { ok: false as const, code: 'FS_READONLY' };
      return { ok: true as const };
    });
    const r = await saveDirtyTabsForClose(
      [tab('/a.ts', true), tab('/b.ts', true), tab('/c.ts', true), tab('/d.ts', true), tab('/e.ts', true)],
      saveTab,
      () => [],
    );
    expect(r).toEqual({
      failed: 4,
      diskChanged: 1,
      readonly: 1,
      untitled: 0,
      failedPaths: ['/b.ts', '/c.ts', '/d.ts', '/e.ts'],
    });
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
    expect(r).toEqual({ failed: 1, diskChanged: 0, readonly: 0, untitled: 0, failedPaths: ['/a.ts'] });
  });
});

// 关窗「保存」失败提示:写明哪些文件(最多 3 个 +「等」)及各类失败的出路(磁盘冲突 / 只读 → 在编辑器按保存键处理,
// 或选「不保存」)。只读的保存键复用当前生效绑定。
describe('saveForCloseFailureMessage:关窗保存失败提示带文件名与出路', () => {
  afterEach(() => setLocale('en'));

  it('≤3 个失败:全部列出文件名;只读追加 readonly_note(含保存键)', () => {
    setLocale('en');
    const msg = saveForCloseFailureMessage(
      { failed: 2, diskChanged: 0, readonly: 2, untitled: 0, failedPaths: ['/w/ro.ts', 'C:\\w\\ro2.md'] },
      'Cmd+S',
    );
    expect(msg).toContain(t('dialog.unsaved_close.save_failed', { count: 2, names: 'ro.ts, ro2.md' }));
    expect(msg).toContain(t('dialog.unsaved_close.readonly_note', { count: 2, hotkey: 'Cmd+S' }));
    expect(msg).toContain('Cmd+S');
    expect(msg).not.toContain(t('dialog.unsaved_close.disk_changed_note', { count: 0, hotkey: 'Cmd+S' }));
  });

  it('>3 个失败:只列前 3 个 +「等」;磁盘冲突与只读两段说明都在', () => {
    setLocale('zh');
    const msg = saveForCloseFailureMessage(
      { failed: 5, diskChanged: 1, readonly: 1, untitled: 0, failedPaths: ['/a', '/b', '/c', '/d', '/e'] },
      'Ctrl+S',
    );
    expect(msg).toContain(
      t('dialog.unsaved_close.save_failed', {
        count: 5,
        names: t('dialog.unsaved_close.names_more', { names: 'a、b、c' }),
      }),
    );
    expect(msg).not.toContain('、d');
    expect(msg).toContain(t('dialog.unsaved_close.disk_changed_note', { count: 1, hotkey: 'Ctrl+S' }));
    expect(msg).toContain(t('dialog.unsaved_close.readonly_note', { count: 1, hotkey: 'Ctrl+S' }));
    // 中文句间不加空格(全角句号后直接接下一句)
    expect(msg).not.toMatch(/。 /);
  });

  it.each(['en', 'zh', 'ko'] as const)('%s:readonly_note 写明只读与「不保存」出路', (locale) => {
    setLocale(locale);
    const note = t('dialog.unsaved_close.readonly_note', { count: 1, hotkey: 'Ctrl+S' });
    expect(note).not.toBe('dialog.unsaved_close.readonly_note');
    expect(note).toContain('Ctrl+S');
    expect(note).toContain(t('dialog.unsaved_close.dont_save'));
  });
});

// perf:「保存」分支原 Promise.all 同时保存全部脏 tab(每个含整文件读比对 + writeFile fsync),
// 数百个大文件时 main 峰值内存与 fsync 并发失控。改为有界并发(上限 SAVE_FOR_CLOSE_CONCURRENCY),
// 按下标汇总结果、失败语义不变。
describe('saveDirtyTabsForClose:有界并发保存', () => {
  it('上限为 32', () => {
    expect(SAVE_FOR_CLOSE_CONCURRENCY).toBe(32);
  });

  it('256 个脏 tab → 峰值在途 ≤ 上限,且全部被保存恰好一次', async () => {
    let inFlight = 0;
    let peak = 0;
    const saveTab = vi.fn(async (_id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return { ok: true as const };
    });
    const tabs = Array.from({ length: 256 }, (_, i) => tab(`/f${i}.ts`, true));
    const r = await saveDirtyTabsForClose(tabs, saveTab, () => []);
    expect(r).toMatchObject({ failed: 0, diskChanged: 0, readonly: 0 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SAVE_FOR_CLOSE_CONCURRENCY);
    expect(saveTab.mock.calls.map((c) => c[0]).sort()).toEqual(tabs.map((t) => t.id).sort());
  });

  it('超过上限时结果仍按下标对位:失败 / 抛异常 / 磁盘冲突 / 保存后仍脏 计数不变', async () => {
    const saveTab = vi.fn(async (id: string) => {
      const i = Number(id.slice(2, -3));
      await new Promise((r) => setTimeout(r, (i * 7) % 5)); // 乱序完成
      if (i % 10 === 1) throw new Error('disk full');
      if (i % 10 === 2) return { ok: false as const, code: 'FS_DENIED' };
      if (i % 10 === 3) return { ok: false as const, code: 'EDITOR_DISK_CHANGED' };
      return { ok: true as const };
    });
    const tabs = Array.from({ length: 100 }, (_, i) => tab(`/f${i}.ts`, true));
    // 保存完成后仍脏:i % 10 === 4(ok 但期间继续输入)与 i % 10 === 2(本就失败,不重复计)
    const after = tabs.map((t, i) => tab(t.filePath, i % 10 === 4 || i % 10 === 2));
    const r = await saveDirtyTabsForClose(tabs, saveTab, () => after);
    expect(r).toMatchObject({ failed: 40, diskChanged: 10, readonly: 0 });
    expect(r.failedPaths).toHaveLength(40);
  });
});

// 终审 P1:「不保存」只丢弃确认框列出的文件;确认时未列入的待 autosave .md(pendingAutoSave)flush 后仍脏 → 不能丢。
describe('remainingAfterDiscard:「不保存」后仍脏的待 autosave .md', () => {
  it('pendingAutoSave 的 tab 已干净 → null(框里的代码文件仍脏也不计)', () => {
    expect(remainingAfterDiscard([tab('/a.md', false), tab('/b.ts', true)], ['/a.md#3'])).toBeNull();
    expect(remainingAfterDiscard([tab('/b.ts', true)], [])).toBeNull();
  });

  it('pendingAutoSave 的 tab 仍脏(含再次变脏、代际不同)→ 全部脏 tab', () => {
    expect(
      remainingAfterDiscard([tab('/a.md', true, '/a.md', 5), tab('/b.ts', true)], ['/a.md#3']),
    ).toEqual({ dirty: 2, ids: ['/a.md#5', '/b.ts#0'] });
  });
});

// 统一规则:全部 flush(含 markdown autosave flush)完成后最终脏检查。autosave 已 flush 过,仍脏的 .md 也算。
describe('remainingAfterFlush:flush 后仍未保存的改动', () => {
  it('全部干净 → null', () => {
    expect(remainingAfterFlush([tab('/a.ts', false), tab('/b.md', false)])).toBeNull();
  });

  it('仍脏的 .md(autosave flush 失败)与代码文件都计入,不看 autosave 设置', () => {
    expect(remainingAfterFlush([tab('/a.md', true), tab('/b.ts', true)])).toEqual({
      dirty: 2,
      ids: ['/a.md#0', '/b.ts#0'],
    });
  });
});

// 复审:main 按上报的脏 id 做「本轮已接受范围」的子集比较。只用 tab id 时,「不保存」后保存 /x.ts 再编辑同一文件
// → 脏 id 仍是 /x.ts → 放行退出丢新改动。上报身份带「变脏代际」:tab 每次 clean→dirty 跃迁递增。
describe('脏 tab 身份带变脏代际', () => {
  it('上报 id 形如 `${tabId}#${gen}`(无代际按 0)', () => {
    expect(
      countDirtyForClose([tab('/a.ts', true, '/a.ts', 2), tab('/b.ts', true, '/b.ts', 1)], DEFAULT_AUTO_SAVE_SETTINGS),
    ).toEqual({ dirty: 2, ids: ['/a.ts#2', '/b.ts#1'] });
  });

  it('editor store:clean→dirty 跃迁取新代际;持续输入不变;保存后再编辑同一文件 → 新代际', () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const s = useEditorStore.getState();
    s.openTab(createTab('/w/x.ts', 'old'));
    const ids = () => countDirtyForClose(useEditorStore.getState().tabs, null).ids;
    expect(ids()).toEqual([]);
    s.updateContent('/w/x.ts', 'new');
    const first = ids();
    expect(first).toHaveLength(1);
    s.updateContent('/w/x.ts', 'newer');
    expect(ids()).toEqual(first);
    s.markSaved('/w/x.ts');
    expect(ids()).toEqual([]);
    s.updateContent('/w/x.ts', 'edited again');
    const second = ids();
    expect(second).toHaveLength(1);
    expect(second).not.toEqual(first);
    // 保存期间继续输入(markSaved 推进已落盘基线但保留 dirty):基线之后的增量是新改动 → 新代际
    s.markSaved('/w/x.ts', 'old');
    const third = ids();
    expect(third).toHaveLength(1);
    expect(third).not.toEqual(second);
    expect(third).not.toEqual(first);
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('editor store:关闭后重开同一路径再编辑 → 新身份(代际进程内唯一,不随 tab 实例重算)', () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const s = useEditorStore.getState();
    const ids = () => countDirtyForClose(useEditorStore.getState().tabs, null).ids;
    s.openTab(createTab('/w/y.ts', 'old'));
    s.updateContent('/w/y.ts', 'new');
    const before = ids();
    expect(before).toHaveLength(1);
    s.closeTab('/w/y.ts');
    s.openTab(createTab('/w/y.ts', 'old'));
    expect(ids()).toEqual([]);
    s.updateContent('/w/y.ts', 'new');
    const after = ids();
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });
});
