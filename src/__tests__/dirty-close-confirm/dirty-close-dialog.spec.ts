// 关窗 / 退出时脏文件确认:main 侧纯函数(脏态上报解析、确认框文案与按钮映射、flush 回执解析)。
// 见同目录 README.md。

import { describe, it, expect, vi } from 'vitest';
import {
  askDirtyClose,
  buildDirtyCloseDialog,
  needsDirtyConfirm,
  parseDirtyState,
  parseFlushAck,
} from '../../../electron/main/dirty-close-confirm';
import { en } from '../../../electron/shared/i18n-locales/en';
import { interpolateTemplate } from '../../../electron/shared/i18n-interpolate';

const t = (key: string, params?: Record<string, string | number>) => {
  const tpl = (en as Record<string, string>)[key] ?? key;
  return params ? interpolateTemplate(tpl, params) : tpl;
};

/** 构造合法脏态(计数由 id 列表推出)。 */
const ds = (ids: string[], untitledIds: string[] = []) => ({
  dirty: ids.length,
  untitled: untitledIds.length,
  ids,
  untitledIds,
});

describe('parseDirtyState:renderer 上报的脏态只接受合法计数与 id 列表', () => {
  it('合法对象原样返回', () => {
    const s = ds(['/a.ts', '/b.ts', 'untitled-1'], ['untitled-1']);
    expect(parseDirtyState(s)).toEqual(s);
    expect(parseDirtyState(ds([]))).toEqual(ds([]));
  });

  it.each([
    null,
    undefined,
    'x',
    { dirty: 1, untitled: 0 }, // 缺 id 列表(复审:main 按身份比较)
    { dirty: 2, untitled: 0, ids: ['/a.ts'], untitledIds: [] }, // 计数与 id 列表不一致
    { dirty: 1, untitled: 1, ids: ['/a.ts'], untitledIds: ['untitled-1'] }, // untitled 不是 ids 子集
    { dirty: 2, untitled: 0, ids: ['/a.ts', '/a.ts'], untitledIds: [] }, // 重复 id
    { dirty: 1, untitled: 0, ids: [''], untitledIds: [] },
    { dirty: 1, untitled: 0, ids: [1], untitledIds: [] },
    { dirty: 1, untitled: 0, ids: ['x'.repeat(8193)], untitledIds: [] }, // 单条超上限
    { dirty: 1, untitled: 0, ids: 'x', untitledIds: [] },
  ])('非法输入 #%# → null', (raw) => {
    expect(parseDirtyState(raw)).toBeNull();
  });

  it('id 列表超上限 → null', () => {
    const ids = Array.from({ length: 100_001 }, (_, i) => `/f${i}`);
    expect(parseDirtyState(ds(ids))).toBeNull();
  });
});

describe('needsDirtyConfirm', () => {
  it('无上报 / 0 个脏文件 → 不弹框', () => {
    expect(needsDirtyConfirm(undefined)).toBe(false);
    expect(needsDirtyConfirm(ds([]))).toBe(false);
  });
  it('有脏文件 → 弹框', () => {
    expect(needsDirtyConfirm(ds(['/a.ts']))).toBe(true);
  });
});

describe('buildDirtyCloseDialog:参考 VSCode 的 保存 / 不保存 / 取消', () => {
  it('按钮顺序固定,默认保存,Esc = 取消', () => {
    const opts = buildDirtyCloseDialog(ds(['/a.ts', '/b.ts']), t);
    expect(opts.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(2);
    expect(opts.message).toContain('2');
    expect(opts.detail).not.toMatch(/untitled/i);
  });

  it('含 untitled 草稿时说明它们无法保存', () => {
    const opts = buildDirtyCloseDialog(ds(['/a.ts', '/b.ts', 'untitled-1'], ['untitled-1']), t);
    expect(opts.message).toContain('3');
    expect(opts.detail).toMatch(/untitled/i);
  });
});

describe('askDirtyClose:把对话框响应映射为用户选择', () => {
  it.each([
    [0, 'save'],
    [1, 'discard'],
    [2, 'cancel'],
    [99, 'cancel'],
  ] as const)('response %d → %s', async (response, choice) => {
    const show = vi.fn(async () => ({ response }));
    await expect(askDirtyClose(ds(['/a.ts']), t, show)).resolves.toBe(choice);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('对话框异常 → 按取消处理(宁可不关也不丢数据)', async () => {
    const show = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(askDirtyClose(ds(['/a.ts']), t, show)).resolves.toBe('cancel');
  });
});

describe('parseFlushAck:renderer flush 回执', () => {
  it('旧格式(无结果)/ 正常 → saveFailed=false,requestId=null', () => {
    const none = { saveFailed: false, requestId: null, remaining: null };
    expect(parseFlushAck(undefined)).toEqual(none);
    expect(parseFlushAck({ saveFailed: false })).toEqual(none);
    expect(parseFlushAck('junk')).toEqual(none);
  });
  it('saveFailed=true 原样透出', () => {
    expect(parseFlushAck({ saveFailed: true })).toEqual({
      saveFailed: true,
      requestId: null,
      remaining: null,
    });
  });
  it('requestId:安全正整数才采纳,畸形值 → null', () => {
    expect(parseFlushAck({ requestId: 7 })).toEqual({
      saveFailed: false,
      requestId: 7,
      remaining: null,
    });
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, '7']) {
      expect(parseFlushAck({ requestId: bad }).requestId).toBeNull();
    }
  });

  // 统一规则:renderer 全部 flush 完成后最终脏检查,仍有未保存改动 → 回执 remaining(计数,main 据此中止并
  // 记账,下次关闭会弹确认)。畸形 / 计数为 0 → null(不中止)。
  it('remaining:合法且 dirty>0 才采纳,畸形 / 0 → null', () => {
    const s = ds(['/a.ts', 'untitled-1'], ['untitled-1']);
    expect(parseFlushAck({ remaining: s }).remaining).toEqual(s);
    for (const bad of [ds([]), { dirty: 1, untitled: 0 }, { dirty: -1 }, 'x', 1]) {
      expect(parseFlushAck({ remaining: bad }).remaining).toBeNull();
    }
  });
});
