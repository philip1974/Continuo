// 终审:调试授权的提示文案曾写「此授权不包含终端控制」,误导用户以为调试授权不涉及执行命令。
// 实际上 debug.launch 运行工作区程序、debug.evaluate 在被调试程序里执行任意表达式(可 require('child_process')),
// 都等价于以当前用户权限执行任意代码。这是调试能力固有的性质,授权前必须如实告知。

import { describe, expect, it } from 'vitest';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const hints = {
  en: (en as Record<string, string>)['permissions.agent.hint_debug'] ?? '',
  zh: (zh as Record<string, string>)['permissions.agent.hint_debug'] ?? '',
  ko: (ko as Record<string, string>)['permissions.agent.hint_debug'] ?? '',
};

describe('调试授权提示如实告知可执行任意代码', () => {
  it('不再声称「不包含终端控制」类的安全暗示', () => {
    expect(hints.zh).not.toContain('不包含终端控制');
    expect(hints.en).not.toMatch(/does not grant terminal access/i);
    expect(hints.ko).not.toContain('터미널 제어를 포함하지 않으며');
  });

  it('三语都说明可以执行任意代码 / 命令', () => {
    expect(hints.zh).toContain('任意代码');
    expect(hints.en).toMatch(/arbitrary code/i);
    expect(hints.ko).toContain('임의의 코드');
  });
});
