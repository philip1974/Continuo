// BDD:窗口几何 windowState 是 explorer.json 窗口段的 main 独占字段:向后兼容旧文件、renderer 写盘合并时保留、
// explorer:read 剥离(剥离清单 = MAIN_OWNED_WINDOW_FIELDS)。见同目录 README 第 1 条。
import { describe, expect, it } from 'vitest';
import {
  ExplorerSchemaV3,
  MAIN_OWNED_WINDOW_FIELDS,
} from '../../../electron/shared/explorer-persistence-schema';
import {
  defaultExplorerV3,
  mergeWritableIntoFull,
  type ExplorerPayloadV3,
  type ExplorerWritablePayload,
} from '../../../electron/main/persistence';

const sort = { by: 'name' as const, reverse: false };
const explorer = { activePath: null, expandedPaths: [], sort };

function payloadWith(windowState: unknown): unknown {
  return {
    ...defaultExplorerV3(),
    windows: [{ windowSeq: 0, workspace: { root: '/w' }, explorer, windowState }],
  };
}

describe('windowState 字段', () => {
  it('合法的 bounds + 最大化 / 全屏 → schema 接受', () => {
    const r = ExplorerSchemaV3.safeParse(
      payloadWith({ bounds: { x: -1440, y: 25, width: 1280, height: 800 }, isMaximized: true, isFullScreen: false }),
    );
    expect(r.success).toBe(true);
  });

  it('旧文件没有 windowState → 照常解析(按新窗口默认尺寸)', () => {
    const r = ExplorerSchemaV3.safeParse({
      ...defaultExplorerV3(),
      windows: [{ windowSeq: 0, workspace: { root: '/w' }, explorer }],
    });
    expect(r.success).toBe(true);
  });

  it('畸形几何(非正尺寸 / 非整数 / 多余字段)→ schema 拒', () => {
    for (const bad of [
      { bounds: { x: 0, y: 0, width: 0, height: 800 } },
      { bounds: { x: 0.5, y: 0, width: 800, height: 800 } },
      { bounds: { x: 0, y: 0, width: 800 } },
      { bounds: { x: 0, y: 0, width: 800, height: 600 }, extra: 1 },
      { bounds: { x: 0, y: 0, width: 1e9, height: 600 } },
    ]) {
      expect(ExplorerSchemaV3.safeParse(payloadWith(bad)).success).toBe(false);
    }
  });

  it('属于 main 独占字段:explorer:read 剥离清单包含它', () => {
    expect(MAIN_OWNED_WINDOW_FIELDS).toContain('windowState');
  });

  it('renderer 写盘合并时保留盘上的 windowState(renderer 无权写)', () => {
    const windowState = { bounds: { x: 10, y: 20, width: 900, height: 700 }, isMaximized: true };
    const current: ExplorerPayloadV3 = {
      ...defaultExplorerV3(),
      windows: [{ windowSeq: 0, workspace: { root: '/old' }, explorer, windowState }],
    };
    const writable: ExplorerWritablePayload = {
      ...defaultExplorerV3(),
      windows: [{ windowSeq: 0, workspace: { root: '/new' }, explorer }],
    };
    const merged = mergeWritableIntoFull(current, writable);
    expect(merged.windows[0]?.workspace.root).toBe('/new');
    expect(merged.windows[0]?.windowState).toEqual(windowState);
  });
});
