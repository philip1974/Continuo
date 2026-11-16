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

describe('parseDirtyState:renderer 上报的脏态只接受合法计数', () => {
  it('合法对象原样返回', () => {
    expect(parseDirtyState({ dirty: 3, untitled: 1 })).toEqual({ dirty: 3, untitled: 1 });
    expect(parseDirtyState({ dirty: 0, untitled: 0 })).toEqual({ dirty: 0, untitled: 0 });
  });

  it.each([
    null,
    undefined,
    'x',
    { dirty: -1, untitled: 0 },
    { dirty: 1.5, untitled: 0 },
    { dirty: Number.NaN, untitled: 0 },
    { dirty: 1, untitled: 2 }, // untitled 是 dirty 的子集
    { dirty: 1 },
    { dirty: 1e9, untitled: 0 }, // 超上限
  ])('非法输入 %j → null', (raw) => {
    expect(parseDirtyState(raw)).toBeNull();
  });
});

describe('needsDirtyConfirm', () => {
  it('无上报 / 0 个脏文件 → 不弹框', () => {
    expect(needsDirtyConfirm(undefined)).toBe(false);
    expect(needsDirtyConfirm({ dirty: 0, untitled: 0 })).toBe(false);
  });
  it('有脏文件 → 弹框', () => {
    expect(needsDirtyConfirm({ dirty: 1, untitled: 0 })).toBe(true);
  });
});

describe('buildDirtyCloseDialog:参考 VSCode 的 保存 / 不保存 / 取消', () => {
  it('按钮顺序固定,默认保存,Esc = 取消', () => {
    const opts = buildDirtyCloseDialog({ dirty: 2, untitled: 0 }, t);
    expect(opts.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(2);
    expect(opts.message).toContain('2');
    expect(opts.detail).not.toMatch(/untitled/i);
  });

  it('含 untitled 草稿时说明它们无法保存', () => {
    const opts = buildDirtyCloseDialog({ dirty: 3, untitled: 1 }, t);
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
    await expect(askDirtyClose({ dirty: 1, untitled: 0 }, t, show)).resolves.toBe(choice);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('对话框异常 → 按取消处理(宁可不关也不丢数据)', async () => {
    const show = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(askDirtyClose({ dirty: 1, untitled: 0 }, t, show)).resolves.toBe('cancel');
  });
});

describe('parseFlushAck:renderer flush 回执', () => {
  it('旧格式(无结果)/ 正常 → saveFailed=false,requestId=null', () => {
    expect(parseFlushAck(undefined)).toEqual({ saveFailed: false, requestId: null });
    expect(parseFlushAck({ saveFailed: false })).toEqual({ saveFailed: false, requestId: null });
    expect(parseFlushAck('junk')).toEqual({ saveFailed: false, requestId: null });
  });
  it('saveFailed=true 原样透出', () => {
    expect(parseFlushAck({ saveFailed: true })).toEqual({ saveFailed: true, requestId: null });
  });
  it('requestId:安全正整数才采纳,畸形值 → null', () => {
    expect(parseFlushAck({ requestId: 7 })).toEqual({ saveFailed: false, requestId: 7 });
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, '7']) {
      expect(parseFlushAck({ requestId: bad }).requestId).toBeNull();
    }
  });
});
