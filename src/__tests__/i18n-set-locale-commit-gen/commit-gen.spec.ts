// race(R36):SET_LOCALE 广播此前用「已发起 gen」(getSetLocaleGen,在 await 写盘前递增)判定 —
// 后发起者递增 gen 后即便写盘失败,也会让先发起且已成功写盘者因「非最新 gen」而不广播 →
// 其它窗口/菜单停旧语言。改用「已提交 gen」(commitSetLocaleGen):只被成功写盘的调用推进,
// 失败调用不碰它,故不会压掉前一个已成功提交者的广播。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  commitSetLocaleGen,
  _resetSettingsForTest,
} from '../../../electron/main/services/settings.service';

beforeEach(() => {
  _resetSettingsForTest();
});

describe('race(R36) · commitSetLocaleGen 已提交 gen 单调推进', () => {
  it('成功提交按 gen 严格递增推进,每次返回 true(应广播)', () => {
    expect(commitSetLocaleGen(1)).toBe(true);
    expect(commitSetLocaleGen(2)).toBe(true);
    expect(commitSetLocaleGen(3)).toBe(true);
  });

  it('R36 核心:后发起者(gen2)写盘失败=从不 commit → 不影响先成功者(gen1)的广播判定', () => {
    // A 发起 gen1、B 发起 gen2(setLocaleGen 已被 B 递增到 2),但 B 写盘失败 → B 永不调 commit。
    // A 写盘成功 → commit(1):旧实现 gen1 !== getSetLocaleGen()(2) 不广播;新实现 committed 0<1 → 广播。
    expect(commitSetLocaleGen(1)).toBe(true);
    // 之后某次成功提交 gen2 仍可广播(committed 1<2),不会被 B 的失败永久卡住。
    expect(commitSetLocaleGen(2)).toBe(true);
  });

  it('乱序/过期成功提交不覆盖更新的已提交 gen', () => {
    expect(commitSetLocaleGen(2)).toBe(true); // 新的先提交
    expect(commitSetLocaleGen(1)).toBe(false); // 迟到的旧 gen 不广播(不压新)
    expect(commitSetLocaleGen(2)).toBe(false); // 相等也不重复广播
  });

  it('_resetSettingsForTest 重置 committed gen', () => {
    commitSetLocaleGen(5);
    _resetSettingsForTest();
    expect(commitSetLocaleGen(1)).toBe(true); // 重置后 gen1 又是最新
  });
});
