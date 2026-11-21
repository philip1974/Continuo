// 边界(E274,E268 收口):leaf 校验收口到 shared leafNameRejectReason/isValidLeafName,与 plugin-fs
// validateLeaf 同一最强规则集。补 Windows 危险名(:/ADS、保留设备名、尾随点/空格、NTFS 8.3、~)与 NFC。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  isValidLeafName,
  leafNameRejectReason,
  FS_NAME_MAX,
} from '../../../electron/shared/leaf-name';

describe('isValidLeafName(E274)', () => {
  it('合法名 → true', () => {
    expect(isValidLeafName('valid-file_name.txt')).toBe(true);
    expect(isValidLeafName('foo.bar-baz.json')).toBe(true);
    expect(isValidLeafName('用户文档.md')).toBe(true); // 非 ASCII 但 NFC、无危险字符
  });

  it.each([
    ['', '空'],
    ['.', '点'],
    ['..', '点点'],
    ['a/b', '正斜杠'],
    ['a\\b', '反斜杠'],
    ['foo~bar', '波浪号'],
    ['PROGRA~1', 'NTFS 8.3'],
    ['foo..bar', '..子串'],
    ['a:b', '冒号 ADS'],
    ['CON', '保留名 CON'],
    ['con', '保留名 con(大小写不敏感)'],
    ['NUL.txt', '保留名 NUL.ext'],
    ['LPT1', '保留名 LPT1'],
    ['foo.', '尾随点'],
    ['foo ', '尾随空格'],
    ['café', '非 NFC(NFD)'],
  ])('拒非法 leaf %s(%s)', (bad) => {
    expect(isValidLeafName(bad)).toBe(false);
    expect(leafNameRejectReason(bad)).not.toBeNull();
  });

  it('控制字符 / NUL → false', () => {
    expect(isValidLeafName('a\x01b')).toBe(false);
    expect(isValidLeafName('a\x00b')).toBe(false);
  });

  it('非 string → false', () => {
    expect(isValidLeafName(null)).toBe(false);
    expect(isValidLeafName(42 as unknown)).toBe(false);
  });

  it('reason 文案与原 validateLeaf 一致(契约保持)', () => {
    expect(leafNameRejectReason('')).toBe('empty leaf');
    expect(leafNameRejectReason('.')).toBe('leaf is "."');
    expect(leafNameRejectReason('a:b')).toContain('Windows ADS');
    expect(leafNameRejectReason('CON')).toContain('Windows reserved');
    expect(leafNameRejectReason('foo.')).toContain('trailing dot or space');
    expect(leafNameRejectReason('café')).toContain('not NFC-normalized');
  });

  it('Windows/NTFS 危险名检测走字符扫描,不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(leafNameRejectReason('CON.txt')).toBe(
        'leaf is Windows reserved device name',
      );
      expect(leafNameRejectReason('COM1.log')).toBe(
        'leaf is Windows reserved device name',
      );
      expect(leafNameRejectReason('LPT9')).toBe(
        'leaf is Windows reserved device name',
      );
      expect(leafNameRejectReason('PROGRA~1')).toBe(
        'leaf matches NTFS 8.3 short-name pattern',
      );
      expect(leafNameRejectReason('COM0')).toBeNull();
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('FS_NAME_MAX 截断常量存在(drop failed.name 显示用)', () => {
    expect(FS_NAME_MAX).toBe(255);
  });
});

// 收口接线守卫:plugin-fs 写路径 validateLeaf 必须委托共享 leafNameRejectReason(消漂移防回归)。
describe('E274 收口接线守卫:path-resolve.helper validateLeaf 委托共享 helper', () => {
  it('path-resolve.helper.ts 调用 leafNameRejectReason', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../electron/main/services/path-resolve.helper.ts',
    );
    const src = readFileSync(p, 'utf-8');
    expect(src).toContain('leafNameRejectReason(');
  });
});
