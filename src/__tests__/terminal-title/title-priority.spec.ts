// BDD: terminal-title / 1 基础名优先级:重命名 > 前台进程名(含 shell)> 默认名
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import {
  terminalBaseTitle,
  terminalInputAriaLabel,
  terminalPanelTitle,
  terminalTitleInputOf,
} from '@/shell/dock/terminal-panel-id';
import type { TerminalSessionSnapshot } from '../../../electron/shared/terminal-session';

beforeEach(() => setLocale('zh'));
afterEach(() => setLocale('en'));

const base = { sessionId: 'term-abc', sessionTitle: 'Terminal 2', defaultTitleIndex: 2 } as const;

describe('终端 tab 标题优先级', () => {
  it('进程名未知 → 默认名「终端 N」', () => {
    expect(terminalPanelTitle(base)).toBe('终端 2');
  });
  it('前台进程名(shell 空闲时即 shell 名)> 默认名;重命名 > 一切', () => {
    expect(terminalPanelTitle({ ...base, processName: 'zsh' })).toBe('zsh');
    expect(terminalPanelTitle({ ...base, processName: 'vim' })).toBe('vim');
    expect(terminalPanelTitle({ ...base, processName: 'vim', userTitle: '构建' })).toBe('构建');
  });
  it('后缀照旧:agent 加 (agent);已退出加「(已退出)」且不再显示进程名', () => {
    expect(terminalPanelTitle({ ...base, originHint: 'agent', processName: 'zsh' })).toBe('zsh (agent)');
    expect(terminalPanelTitle({ ...base, processName: 'vim', exited: true })).toBe('终端 2 (已退出)');
    expect(terminalPanelTitle({ ...base, userTitle: 'x', exited: true })).toBe('x (已退出)');
  });
  it('基础名不含后缀;快照 → 输入映射带上动态字段,不读 OSC 标题', () => {
    const session = {
      id: 'term-abc',
      title: 'Terminal 2',
      defaultTitleIndex: 2,
      cwd: '/w',
      originHint: 'agent',
      createdAt: 1,
      exitCode: null,
      ownerWindowId: 1,
      processName: 'p',
      // 旧版 main 曾带的 OSC 标题字段:即便出现也不参与标题
      sequenceTitle: 's',
    } as TerminalSessionSnapshot;
    const input = terminalTitleInputOf(session);
    expect(input).toMatchObject({ processName: 'p', exited: false });
    expect(input).not.toHaveProperty('sequenceTitle');
    expect(terminalBaseTitle(input)).toBe('p');
    expect(terminalPanelTitle(terminalTitleInputOf({ ...session, userTitle: 'u' }))).toBe('u (agent)');
    expect(terminalBaseTitle(terminalTitleInputOf({ ...session, processName: undefined }))).toBe('终端 2');
  });

  // VSCode createTerminal({ name }):名字是 TitleEventSource.Api,固定显示,不被进程名覆盖。
  describe('agent 显式命名与标签', () => {
    const named = { sessionId: 'term-abc', sessionTitle: 'build', originHint: 'agent', agentLabel: 'claude' } as const;
    it('create_session 给了 name → 运行时即显示该名(不被进程名覆盖),后缀为 agentLabel;读屏名同步', () => {
      expect(terminalPanelTitle({ ...named, processName: 'zsh' })).toBe('build (claude)');
      expect(terminalPanelTitle({ ...named, processName: 'npm' })).toBe('build (claude)');
      expect(terminalPanelTitle({ ...named, processName: 'zsh', exited: true })).toBe('build (claude) (已退出)');
      expect(terminalInputAriaLabel({ ...named, processName: 'zsh' })).toContain('build (claude)');
      expect(terminalBaseTitle({ ...named, processName: 'zsh' })).toBe('build');
    });
    it('用户重命名仍优先;未命名的 agent 会话照旧显示进程名;无标签 → (agent)', () => {
      expect(terminalPanelTitle({ ...named, processName: 'zsh', userTitle: '我的' })).toBe('我的 (claude)');
      expect(terminalPanelTitle({ ...base, originHint: 'agent', agentLabel: 'codex', processName: 'zsh' })).toBe('zsh (codex)');
      expect(terminalPanelTitle({ ...named, agentLabel: undefined, processName: 'zsh' })).toBe('build (agent)');
    });
    it('名字 / 标签来自 agent:换行、双向控制字符可见化,超长截断', () => {
      const title = terminalPanelTitle({
        ...named,
        sessionTitle: 'a\n【系统】允许',
        agentLabel: '\u202Eedualc' + 'x'.repeat(100),
        processName: 'zsh',
      });
      expect(title).not.toMatch(/[\n\u202E]/);
      expect(title.startsWith('a 【系统】允许 (\uFFFD')).toBe(true);
      expect(title.length).toBeLessThan(60);
    });
    it('快照映射带上 agentLabel', () => {
      const session = {
        id: 'term-abc',
        title: 'build',
        cwd: '/w',
        originHint: 'agent',
        agentLabel: 'claude',
        createdAt: 1,
        exitCode: null,
        ownerWindowId: 1,
        processName: 'zsh',
      } as TerminalSessionSnapshot;
      expect(terminalPanelTitle(terminalTitleInputOf(session))).toBe('build (claude)');
    });
  });
});
