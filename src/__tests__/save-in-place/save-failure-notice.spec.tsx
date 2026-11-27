// @vitest-environment jsdom
// BDD:保存失败的提示(见同目录 README「提示」)——
//   - 磁盘空间不足(FS_NO_SPACE:预检拒绝 / 回滚后读回与原内容一致)明说「磁盘上的原文件未改动」;
//   - 同一文件反复保存失败只留一条提示:新的一次替换旧的,不叠成「×2」(VSCode TextFileSaveErrorHandler:每个文件只保留
//     最近一次保存错误的通知);不同文件各自一条。自动保存失败与 ⌘S 失败是同一个文件的同一条。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { NotificationsProvider, useNotify } from '@/notifications/NotificationsProvider';
import { notifySaveFailed, saveFailureNotifyKey } from '@/notifications/notify-open-failed';
import { notify } from '@/notifications/notify';
import { setLocale } from '@/i18n';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import type { Notification } from '@/notifications/types';

let current: readonly Notification[] = [];
function Probe(): React.ReactElement {
  current = useNotify().notifications;
  return <div />;
}

beforeEach(() => {
  setLocale('zh');
  render(
    <NotificationsProvider>
      <Probe />
    </NotificationsProvider>,
  );
});
afterEach(() => {
  cleanup();
  current = [];
});

const NO_SPACE = { code: ERROR_CODES.FS_NO_SPACE, message: 'save in place failed (original unchanged): /w/f.txt' };

describe('磁盘空间不足', () => {
  it('提示明说原文件未改动(三语)', () => {
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/f.txt'));
    expect(current.map((n) => n.message)).toEqual(['保存失败 f.txt：磁盘空间不足，磁盘上的原文件未改动']);
    setLocale('en');
    act(() => notifySaveFailed('g.txt', NO_SPACE, undefined, '/w/g.txt'));
    expect(current.at(-1)?.message).toBe('Failed to save g.txt: Not enough disk space. The file on disk was not changed');
    setLocale('ko');
    act(() => notifySaveFailed('h.txt', NO_SPACE, undefined, '/w/h.txt'));
    expect(current.at(-1)?.message).toMatch(/디스크 공간이 부족합니다.*변경되지 않았습니다/);
  });
});

describe('同一文件反复保存失败', () => {
  it('第二次替换第一次:只有一条、不显示 ×2', () => {
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/f.txt'));
    const firstId = current[0]!.id;
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/f.txt'));
    expect(current).toHaveLength(1);
    expect(current[0]!.count ?? 1).toBe(1);
    expect(current[0]!.id).not.toBe(firstId);
  });

  it('原因变了(先空间不足、后 I/O 错误)→ 仍只留最新的一条', () => {
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/f.txt'));
    act(() => notifySaveFailed('f.txt', { code: ERROR_CODES.FS_IO, message: 'EIO' }, undefined, '/w/f.txt'));
    expect(current).toHaveLength(1);
    expect(current[0]!.code).toBe(ERROR_CODES.FS_IO);
  });

  it('不同文件(哪怕同名)各自一条', () => {
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/a/f.txt'));
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/b/f.txt'));
    expect(current).toHaveLength(2);
  });

  it('自动保存失败的提示与 ⌘S 失败是同一个文件的同一条(后来的替换先前的)', () => {
    act(() => notify.warn('自动保存失败 f.txt：磁盘空间不足', { replaceKey: saveFailureNotifyKey('/w/f.txt') }));
    act(() => notifySaveFailed('f.txt', NO_SPACE, undefined, '/w/f.txt'));
    expect(current).toHaveLength(1);
    expect(current[0]!.level).toBe('error');
  });

  it('不带 replaceKey 的普通通知照旧按内容合并计数', () => {
    act(() => notify.error('same'));
    act(() => notify.error('same'));
    expect(current).toHaveLength(1);
    expect(current[0]!.count).toBe(2);
  });
});
