// 重启恢复哪些主窗口(VSCode window.restoreWindows,默认 all):默认恢复上次退出时开着的全部主窗口,焦点给最后活动的;
// 设置项关掉只恢复一个(最后活动的窗口);运行期用户关掉的窗口不再恢复。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRestoreAllWindowsEnabled,
  lastActiveWindowSeq,
  openWindowSeqsAtLastExit,
  orderByRecentFocus,
  pickPrimaryWindowSeq,
  pickWindowsToRestore,
  updateOpenWindowSeqsOnUserClose,
} from '../../../electron/main/services/window-restore.service';
import {
  defaultExplorerV3,
  ExplorerSchemaV3,
  loadExplorer,
  mergeWritableIntoFull,
  setRestoreAllWindowsOnLaunch,
  type ExplorerPayloadV3,
  type ExplorerWritablePayload,
} from '../../../electron/main/persistence';

const seg = (windowSeq: number, root: string | null) => ({
  windowSeq,
  workspace: { root },
  explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
});

function payload(over: Partial<ExplorerPayloadV3>): ExplorerPayloadV3 {
  return { ...defaultExplorerV3(), ...over };
}

const allDirs = () => true;

describe('设置项缺省 = 恢复全部(VSCode 默认 all;旧数据 undefined 视为 true)', () => {
  it('undefined / true → 开;false → 关', () => {
    expect(isRestoreAllWindowsEnabled(payload({}))).toBe(true);
    expect(isRestoreAllWindowsEnabled(payload({ restoreAllWindowsOnLaunch: true }))).toBe(true);
    expect(isRestoreAllWindowsEnabled(payload({ restoreAllWindowsOnLaunch: false }))).toBe(false);
  });
});

describe('恢复全部(默认)', () => {
  const data = payload({
    windows: [seg(0, '/ws-a'), seg(3, '/ws-b'), seg(5, '/ws-closed')],
    openWindowSeqs: [3, 0], // 退出时 0 与 3 开着;5 在退出前已被用户关掉;0 最后活动
  });

  it('首窗 = 主窗 seq 0(在列表里时);其余开着的窗口异步恢复;退出前关掉的不恢复', async () => {
    expect(pickPrimaryWindowSeq(data)).toBe(0);
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([{ windowSeq: 3, workspace: '/ws-b' }]);
  });

  it('焦点给最后活动的窗口(列表最后一个)', () => {
    expect(lastActiveWindowSeq(data)).toBe(0);
  });

  it('主窗 seq 0 在退出前已被关掉 → 不再打开它,首窗取列表第一个', async () => {
    const d = payload({ windows: [seg(0, '/ws-a'), seg(3, '/ws-b'), seg(4, '/ws-c')], openWindowSeqs: [3, 4] });
    expect(pickPrimaryWindowSeq(d)).toBe(3);
    expect(await pickWindowsToRestore(d, allDirs)).toEqual([{ windowSeq: 4, workspace: '/ws-c' }]);
    expect(lastActiveWindowSeq(d)).toBe(4);
  });

  it('没有退出记录(旧数据 / 从未正常退出)→ 只开主窗 seq 0,不把历史段一股脑弹出来', async () => {
    const d = payload({ windows: [seg(0, '/ws-a'), seg(3, '/ws-b')] });
    expect(pickPrimaryWindowSeq(d)).toBe(0);
    expect(await pickWindowsToRestore(d, allDirs)).toEqual([]);
    expect(lastActiveWindowSeq(d)).toBeNull();
  });

  it('目录已不存在的窗口不恢复', async () => {
    const d = payload({ windows: [seg(0, '/ws-a'), seg(3, '/gone')], openWindowSeqs: [0, 3] });
    expect(await pickWindowsToRestore(d, (p) => p !== '/gone')).toEqual([]);
  });
});

describe('只恢复一个(设置项关)', () => {
  it('首窗 = 上次最后活动的窗口,其余都不恢复', async () => {
    const d = payload({
      restoreAllWindowsOnLaunch: false,
      windows: [seg(0, '/ws-a'), seg(3, '/ws-b')],
      openWindowSeqs: [0, 3],
    });
    expect(pickPrimaryWindowSeq(d)).toBe(3);
    expect(await pickWindowsToRestore(d, allDirs)).toEqual([]);
  });

  it('没有退出记录 → 主窗 seq 0', () => {
    expect(pickPrimaryWindowSeq(payload({ restoreAllWindowsOnLaunch: false }))).toBe(0);
  });
});

describe('openWindowSeqs 的读取与维护', () => {
  it('读取:去掉非安全整数,重复项只按最后一次出现计', () => {
    const d = payload({ openWindowSeqs: [1, 2, Number.MAX_SAFE_INTEGER + 2, 1] });
    expect(openWindowSeqsAtLastExit(d)).toEqual([2, 1]);
  });

  it('退出时按最近活动排序:没聚焦过的在前,聚焦过的按聚焦先后,最后一个 = 最后活动', () => {
    expect(orderByRecentFocus([0, 3, 7], [3, 9, 0])).toEqual([7, 3, 0]);
    expect(orderByRecentFocus([0, 3], [])).toEqual([0, 3]);
  });

  it('用户关掉一个窗口、还有别的开着 → 移出;关掉最后一个 → 只留它;没有记录且还有别的开着 → 不建记录', () => {
    const p1: { openWindowSeqs?: number[] } = { openWindowSeqs: [0, 3] };
    updateOpenWindowSeqsOnUserClose(p1, 3, [0]);
    expect(p1.openWindowSeqs).toEqual([0]);

    const p2: { openWindowSeqs?: number[] } = { openWindowSeqs: [0, 3] };
    updateOpenWindowSeqsOnUserClose(p2, 3, []);
    expect(p2.openWindowSeqs).toEqual([3]);

    const p3: { openWindowSeqs?: number[] } = {};
    updateOpenWindowSeqsOnUserClose(p3, 3, [0]);
    expect(p3.openWindowSeqs).toBeUndefined();
  });

  it('schema 接受 openWindowSeqs;renderer 整份写回时保留盘上值、忽略 renderer 带来的值', () => {
    const current = payload({ openWindowSeqs: [0, 4] });
    expect(ExplorerSchemaV3.safeParse(current).success).toBe(true);
    const writable = { ...defaultExplorerV3(), openWindowSeqs: [9] } as unknown as ExplorerWritablePayload;
    expect(mergeWritableIntoFull(current, writable).openWindowSeqs).toEqual([0, 4]);
    const fresh = mergeWritableIntoFull(null, writable);
    expect('openWindowSeqs' in fresh).toBe(false);
  });
});

describe('setRestoreAllWindowsOnLaunch(设置项写入 main 启动偏好)', () => {
  let dir = '';
  let file = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'restore-windows-'));
    file = path.join(dir, 'explorer.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('开(默认)且盘上未设置 → 不写盘(保持「未设置」= 默认开)', async () => {
    await setRestoreAllWindowsOnLaunch(file, true);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('关 → 写 false;再开 → 写 true;其余内容保留', async () => {
    await fs.writeFile(file, JSON.stringify(payload({ windows: [seg(0, '/ws-a')], openWindowSeqs: [0] })));
    await setRestoreAllWindowsOnLaunch(file, false);
    let saved = await loadExplorer(file);
    expect(saved?.restoreAllWindowsOnLaunch).toBe(false);
    expect(saved?.openWindowSeqs).toEqual([0]);
    expect(saved?.windows[0]?.workspace.root).toBe('/ws-a');
    await setRestoreAllWindowsOnLaunch(file, true);
    saved = await loadExplorer(file);
    expect(saved?.restoreAllWindowsOnLaunch).toBe(true);
  });
});
