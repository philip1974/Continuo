// @vitest-environment jsdom
// 编辑器侧:tab 记住编码、按编码保存 / 读盘、通过编码重新打开 / 保存、更改行尾、打开非 UTF-8 文件弹编码选择器。
// 行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import {
  openFileByPath,
  reopenWithEncoding,
  revertFile,
  saveFile,
  type EditorFileDeps,
} from '../../panels/Editor/editor-file-actions';
import { findEditorFileTabById } from '../../panels/Editor/editor-tab-lookup';
import { convertLineEndings, lineEndingOf, readOptionsForTab } from '../../panels/Editor/editor-encoding';
import { clearRecentlyClosedEditors, popRecentlyClosedEditor } from '../../panels/Editor/recently-closed-editors';
import { createTab, useEditorStore, type EditorTab } from '../../stores/editor.store';
import { toFsReadFileResult, type FsReadFileResult } from '../../../electron/shared/fs-channels';
import { encodingPickItems } from '../../plugins/editor-encoding/encoding-picks';
import { acceptEncodingPick, changeLineEnding } from '../../plugins/editor-encoding/encoding-actions';
import { useEncodingPickerStore } from '../../plugins/editor-encoding/store';
import { openFileOrNotify } from '../../notifications/notify-open-failed';
import { notify } from '../../notifications/notify';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';

type ReadOpts = { readonly encoding?: TextEncodingId } | undefined;

/** 磁盘:path → { 文本, 编码 };readFile 按请求的编码「解码」(编码不符 → FS_UNKNOWN_ENCODING,模拟 GBK 自动识别失败)。 */
function diskFs(disk: Map<string, { text: string; encoding: TextEncodingId; autoDetectable: boolean }>) {
  const readFile = vi.fn(async (p: string, opts?: ReadOpts): Promise<FsReadFileResult> => {
    const f = disk.get(p);
    if (!f) return { ok: false, code: 'FS_NOT_FOUND', message: 'nf' };
    if (opts?.encoding === undefined && !f.autoDetectable) return { ok: false, code: 'FS_UNKNOWN_ENCODING', message: 'x' };
    const encoding = opts?.encoding ?? f.encoding;
    return encoding === 'utf8' ? { ok: true, data: f.text } : { ok: true, data: f.text, encoding };
  });
  const writeFile = vi.fn(async (p: string, content: string, opts?: { readonly encoding?: TextEncodingId }) => {
    if (opts?.encoding === 'gbk' && /\p{Extended_Pictographic}/u.test(content)) {
      return { ok: false as const, code: 'FS_UNENCODABLE', message: 'x' };
    }
    const prev = disk.get(p);
    disk.set(p, { text: content, encoding: opts?.encoding ?? 'utf8', autoDetectable: prev?.autoDetectable ?? true });
    return { ok: true as const, data: undefined };
  });
  return { readFile, writeFile };
}

let disk: Map<string, { text: string; encoding: TextEncodingId; autoDetectable: boolean }>;
let fs: ReturnType<typeof diskFs>;
let deps: EditorFileDeps;

beforeEach(() => {
  disk = new Map();
  fs = diskFs(disk);
  deps = { fs };
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: { fs }, writable: true, configurable: true });
  captureLmApi();
  useEncodingPickerStore.getState().close();
  useEncodingPickerStore.getState().setConfirmReopen(null);
  clearRecentlyClosedEditors();
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

const tabOf = (id: string): EditorTab => findEditorFileTabById(useEditorStore.getState().tabs, id)!;

describe('tab 记住磁盘编码,保存按它写回', () => {
  it('打开 UTF-16 LE 文件 → tab.encoding = utf16le(未选定);保存带 encoding;UTF-8 文件保存载荷不变', async () => {
    disk.set('/w/a.txt', { text: 'x\r\n', encoding: 'utf16le', autoDetectable: true });
    disk.set('/w/b.txt', { text: 'y', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    await openFileByPath('/w/b.txt', deps);
    expect(tabOf('/w/a.txt')).toMatchObject({ encoding: 'utf16le' });
    expect(tabOf('/w/a.txt').encodingPinned).toBeUndefined();
    expect('encoding' in tabOf('/w/b.txt')).toBe(false);
    useEditorStore.getState().updateContent('/w/a.txt', 'x!\r\n');
    useEditorStore.getState().updateContent('/w/b.txt', 'y!');
    expect((await saveFile('/w/a.txt', deps)).ok).toBe(true);
    expect((await saveFile('/w/b.txt', deps)).ok).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith('/w/a.txt', 'x!\r\n', { encoding: 'utf16le' });
    expect(fs.writeFile).toHaveBeenCalledWith('/w/b.txt', 'y!');
    // 未选定编码:保存前比对按自动识别读(不带 encoding)
    expect(fs.readFile).toHaveBeenCalledWith('/w/a.txt');
  });

  it('以 GBK 打开(选定)→ 保存前比对 / 还原都按 GBK 读,保存按 GBK 写', async () => {
    disk.set('/w/g.txt', { text: '中文', encoding: 'gbk', autoDetectable: false });
    expect((await openFileByPath('/w/g.txt', deps)).ok).toBe(false); // 自动识别失败
    expect((await openFileByPath('/w/g.txt', deps, { encoding: 'gbk' })).ok).toBe(true);
    expect(tabOf('/w/g.txt')).toMatchObject({ encoding: 'gbk', encodingPinned: true, content: '中文' });
    useEditorStore.getState().updateContent('/w/g.txt', '中文改');
    fs.readFile.mockClear();
    expect((await saveFile('/w/g.txt', deps)).ok).toBe(true);
    expect(fs.readFile).toHaveBeenCalledWith('/w/g.txt', { encoding: 'gbk' });
    expect(fs.writeFile).toHaveBeenLastCalledWith('/w/g.txt', '中文改', { encoding: 'gbk' });
    useEditorStore.getState().updateContent('/w/g.txt', 'dirty');
    expect((await revertFile('/w/g.txt', deps)).ok).toBe(true);
    expect(tabOf('/w/g.txt')).toMatchObject({ content: '中文改', dirty: false, encoding: 'gbk', encodingPinned: true });
  });
});

describe('通过编码保存 / 重新打开', () => {
  it('通过编码保存成功 → tab 改为该编码并选定;表示不了的字符 → FS_UNENCODABLE,不写,编码与脏态不变', async () => {
    disk.set('/w/a.txt', { text: '中文', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    expect((await saveFile('/w/a.txt', deps, { encoding: 'gbk' })).ok).toBe(true);
    expect(fs.writeFile).toHaveBeenLastCalledWith('/w/a.txt', '中文', { encoding: 'gbk' });
    expect(tabOf('/w/a.txt')).toMatchObject({ encoding: 'gbk', encodingPinned: true });

    useEditorStore.getState().updateContent('/w/a.txt', '中文😀');
    const r = await saveFile('/w/a.txt', deps, { encoding: 'gbk' });
    expect(r).toMatchObject({ ok: false, code: 'FS_UNENCODABLE' });
    expect(disk.get('/w/a.txt')!.text).toBe('中文');
    expect(tabOf('/w/a.txt')).toMatchObject({ encoding: 'gbk', dirty: true, content: '中文😀' });
  });

  it('通过编码重新打开:按所选编码重读,丢弃未保存修改并选定编码;读失败 tab 不变', async () => {
    disk.set('/w/a.txt', { text: 'abc', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    useEditorStore.getState().updateContent('/w/a.txt', 'abc edited');
    expect((await reopenWithEncoding('/w/a.txt', 'windows1252', deps)).ok).toBe(true);
    expect(fs.readFile).toHaveBeenLastCalledWith('/w/a.txt', { encoding: 'windows1252' });
    expect(tabOf('/w/a.txt')).toMatchObject({ content: 'abc', dirty: false, encoding: 'windows1252', encodingPinned: true });
    expect(readOptionsForTab(tabOf('/w/a.txt'))).toEqual({ encoding: 'windows1252' });

    fs.readFile.mockResolvedValueOnce({ ok: false, code: 'FS_DECODE_FAILED', message: 'x' });
    expect(await reopenWithEncoding('/w/a.txt', 'shiftjis', deps)).toMatchObject({ ok: false, code: 'FS_DECODE_FAILED' });
    expect(tabOf('/w/a.txt')).toMatchObject({ encoding: 'windows1252' });
  });

  it('外部同步 reloadFromDisk:干净 tab 随读盘更新编码;脏 tab 不重载也不改编码', () => {
    const store = useEditorStore.getState();
    store.openTab(createTab('/w/c.txt', 'same'));
    store.reloadFromDisk('/w/c.txt', 'same', undefined, { encoding: 'utf8bom' });
    expect(tabOf('/w/c.txt')).toMatchObject({ content: 'same', encoding: 'utf8bom' });
    store.updateContent('/w/c.txt', 'mine');
    store.reloadFromDisk('/w/c.txt', 'theirs', undefined, { encoding: 'utf16le' });
    expect(tabOf('/w/c.txt')).toMatchObject({ content: 'mine', encoding: 'utf8bom' });
  });

  it('选定的编码随 ⇧⌘T 最近关闭条目保留', () => {
    const store = useEditorStore.getState();
    store.openTab({ ...createTab('/w/g.txt', '中', undefined, 'gbk'), encodingPinned: true });
    store.closeTab('/w/g.txt');
    expect(popRecentlyClosedEditor()).toMatchObject({ path: '/w/g.txt', encoding: 'gbk' });
  });
});

describe('preload 读结果的编码字段', () => {
  it('utf8 / 缺省不带;合法编码透传;未知编码 → 失败(不按 UTF-8 理解别的编码)', () => {
    expect(toFsReadFileResult({ ok: true, data: { content: 'a', encoding: 'utf8' } }, 100)).toEqual({ ok: true, data: 'a' });
    expect(toFsReadFileResult({ ok: true, data: { content: 'a', encoding: 'gbk' } }, 100)).toEqual({
      ok: true,
      data: 'a',
      encoding: 'gbk',
    });
    const bad = toFsReadFileResult({ ok: true, data: { content: 'a', encoding: 'ebcdic' as TextEncodingId } }, 100);
    expect(bad.ok).toBe(false);
  });
});

describe('更改行尾序列', () => {
  it('行尾判定与整篇转换', () => {
    expect(lineEndingOf('a\r\nb\r\n')).toBe('CRLF');
    expect(lineEndingOf('a\nb')).toBe('LF');
    expect(lineEndingOf('a\r\nb\n')).toBe('LF'); // 混合按 LF(编辑后统一为 LF)
    expect(convertLineEndings('a\nb\r\nc\rd', 'CRLF')).toBe('a\r\nb\r\nc\r\nd');
    expect(convertLineEndings('a\r\nb\r\n', 'LF')).toBe('a\nb\n');
  });

  it('切到 CRLF → tab 变脏,保存写回 CRLF', async () => {
    disk.set('/w/a.txt', { text: 'a\nb\n', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    changeLineEnding('/w/a.txt', 'CRLF');
    expect(tabOf('/w/a.txt')).toMatchObject({ content: 'a\r\nb\r\n', dirty: true });
    await saveFile('/w/a.txt', deps);
    expect(disk.get('/w/a.txt')!.text).toBe('a\r\nb\r\n');
  });
});

describe('编码 / 行尾选择器', () => {
  it('第一步两项;重新打开不列 UTF-8 with BOM(utf8bom 的 tab 选中 UTF-8);保存列出全部;行尾选中当前', () => {
    expect(encodingPickItems({ kind: 'action', tabId: 't' }).items.map((i) => i.id)).toEqual(['reopen', 'save']);
    const reopen = encodingPickItems({ kind: 'reopen', tabId: 't' }, { encoding: 'utf8bom' });
    expect(reopen.items.map((i) => i.id)).not.toContain('utf8bom');
    expect(reopen.items[reopen.selectedIndex]!.id).toBe('utf8');
    expect(reopen.items.map((i) => i.id)).toEqual(expect.arrayContaining(['gbk', 'gb18030', 'cp950', 'shiftjis', 'eucjp', 'euckr', 'windows1252', 'iso88591']));
    const save = encodingPickItems({ kind: 'save', tabId: 't' }, { encoding: 'utf16le' });
    expect(save.items.map((i) => i.id)).toContain('utf8bom');
    expect(save.items[save.selectedIndex]!.label).toBe('UTF-16 LE');
    const eol = encodingPickItems({ kind: 'eol', tabId: 't' }, { eol: 'CRLF' });
    expect(eol.items.map((i) => i.id)).toEqual(['LF', 'CRLF']);
    expect(eol.selectedIndex).toBe(1);
  });

  it('脏 tab 选「通过编码重新打开」→ 先要求确认,不读盘;干净 tab 直接按编码重读', async () => {
    disk.set('/w/a.txt', { text: 'abc', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    useEditorStore.getState().updateContent('/w/a.txt', 'edited');
    fs.readFile.mockClear();
    acceptEncodingPick({ kind: 'reopen', tabId: '/w/a.txt' }, 'iso88591');
    expect(useEncodingPickerStore.getState().confirmReopen).toEqual({ tabId: '/w/a.txt', encoding: 'iso88591' });
    expect(fs.readFile).not.toHaveBeenCalled();

    useEditorStore.getState().updateContent('/w/a.txt', 'abc');
    useEncodingPickerStore.getState().setConfirmReopen(null);
    acceptEncodingPick({ kind: 'reopen', tabId: '/w/a.txt' }, 'iso88591');
    await vi.waitFor(() => expect(tabOf('/w/a.txt').encoding).toBe('iso88591'));
    expect(fs.readFile).toHaveBeenCalledWith('/w/a.txt', { encoding: 'iso88591' });
    expect(useEncodingPickerStore.getState().confirmReopen).toBeNull();
  });

  it('选「通过编码保存」+ GBK 遇 emoji → 提示无法表示,文件不变', async () => {
    disk.set('/w/a.txt', { text: 'hi😀', encoding: 'utf8', autoDetectable: true });
    await openFileByPath('/w/a.txt', deps);
    const err = vi.spyOn(notify, 'error').mockImplementation(() => {});
    acceptEncodingPick({ kind: 'save', tabId: '/w/a.txt' }, 'gbk');
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(err.mock.calls[0]![0]).toContain('Simplified Chinese (GBK)');
    expect(err.mock.calls[0]![1]).toEqual({ code: 'FS_UNENCODABLE' });
    expect(disk.get('/w/a.txt')).toMatchObject({ text: 'hi😀', encoding: 'utf8' });
    expect(tabOf('/w/a.txt').encoding).toBeUndefined();
  });
});

describe('打开非 UTF-8 文件:弹编码选择器', () => {
  it('FS_UNKNOWN_ENCODING 且给了按编码打开 → 不弹打开失败,选择器列出编码;选定后按该编码打开', async () => {
    disk.set('/w/g.txt', { text: '中文', encoding: 'gbk', autoDetectable: false });
    const err = vi.spyOn(notify, 'error').mockImplementation(() => {});
    const opened = await openFileOrNotify(
      () => openFileByPath('/w/g.txt', deps),
      'g.txt',
      undefined,
      (encoding) => openFileByPath('/w/g.txt', deps, { encoding }),
    );
    expect(opened).toBe(false);
    expect(err).not.toHaveBeenCalled();
    const req = useEncodingPickerStore.getState().request;
    expect(useEncodingPickerStore.getState().isOpen).toBe(true);
    expect(req).toMatchObject({ kind: 'open', name: 'g.txt' });
    acceptEncodingPick(req!, 'gbk');
    await vi.waitFor(() => expect(tabOf('/w/g.txt')).toMatchObject({ content: '中文', encoding: 'gbk', encodingPinned: true }));
    expect(useEncodingPickerStore.getState().isOpen).toBe(false);
  });

  it('二进制(FS_NOT_UTF8)照常提示打开失败,不弹选择器', async () => {
    const err = vi.spyOn(notify, 'error').mockImplementation(() => {});
    fs.readFile.mockResolvedValueOnce({ ok: false, code: 'FS_NOT_UTF8', message: 'bin' });
    await openFileOrNotify(() => openFileByPath('/w/bin', deps), 'bin', undefined, () => openFileByPath('/w/bin', deps));
    expect(err).toHaveBeenCalledTimes(1);
    expect(useEncodingPickerStore.getState().isOpen).toBe(false);
  });
});
