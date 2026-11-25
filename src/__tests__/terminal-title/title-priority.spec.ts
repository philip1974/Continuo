// BDD: terminal-title / 1 基础名优先级:重命名 > 前台程序名 > OSC 标题 > 默认名
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { terminalBaseTitle, terminalPanelTitle, terminalTitleInputOf } from '@/shell/dock/terminal-panel-id';
import type { TerminalSessionSnapshot } from '../../../electron/shared/terminal-session';

beforeEach(() => setLocale('zh'));
afterEach(() => setLocale('en'));

const base = { sessionId: 'term-abc', sessionTitle: 'Terminal 2', defaultTitleIndex: 2 } as const;

describe('终端 tab 标题优先级', () => {
  it('无动态标题 → 默认名「终端 N」', () => {
    expect(terminalPanelTitle(base)).toBe('终端 2');
  });
  it('OSC 标题 > 默认名;前台程序名 > OSC 标题;重命名 > 一切', () => {
    expect(terminalPanelTitle({ ...base, sequenceTitle: 'MYTITLE' })).toBe('MYTITLE');
    expect(terminalPanelTitle({ ...base, sequenceTitle: 'MYTITLE', processName: 'vim' })).toBe('vim');
    expect(terminalPanelTitle({ ...base, sequenceTitle: 'MYTITLE', processName: 'vim', userTitle: '构建' })).toBe('构建');
  });
  it('后缀照旧:agent 加 (agent);已退出加「(已退出)」且不再显示前台程序名', () => {
    expect(terminalPanelTitle({ ...base, originHint: 'agent', sequenceTitle: 'T' })).toBe('T (agent)');
    expect(terminalPanelTitle({ ...base, processName: 'vim', exited: true })).toBe('终端 2 (已退出)');
    expect(terminalPanelTitle({ ...base, userTitle: 'x', exited: true })).toBe('x (已退出)');
  });
  it('基础名不含后缀;快照 → 输入映射带上三个动态字段', () => {
    const session: TerminalSessionSnapshot = {
      id: 'term-abc',
      title: 'Terminal 2',
      defaultTitleIndex: 2,
      cwd: '/w',
      originHint: 'agent',
      createdAt: 1,
      exitCode: null,
      ownerWindowId: 1,
      userTitle: 'u',
      processName: 'p',
      sequenceTitle: 's',
    };
    const input = terminalTitleInputOf(session);
    expect(input).toMatchObject({ userTitle: 'u', processName: 'p', sequenceTitle: 's', exited: false });
    expect(terminalBaseTitle(input)).toBe('u');
    expect(terminalPanelTitle(input)).toBe('u (agent)');
  });
});
