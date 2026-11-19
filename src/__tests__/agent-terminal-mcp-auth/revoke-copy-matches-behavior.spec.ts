// 「撤销全部」确认框的文案须如实说明撤销之后会怎样(用户据此决定是否撤销)。行为见同目录 README「撤销之后」。
// 事实:撤销会轮换全部 token;现存终端 env 里的旧 token 不会更新,其中的 agent(已运行的,或之后在同一终端里
// 重新启动的)再也拿不到窗口上下文 —— 须在**新开的终端**里启动 agent 才能再次请求授权。
// 这里钉的是「必须点明的事实」,不钉整句措辞。
import { describe, expect, it } from 'vitest';
import { en } from '../../../electron/shared/i18n-locales/en';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { zh } from '../../../electron/shared/i18n-locales/zh';

const KEYS = ['permissions.revoke_all.confirm_grant_only', 'permissions.revoke_all.confirm'] as const;

describe('撤销确认文案与撤销后的实际行为一致', () => {
  it.each([
    ['en', en, /new terminal/i],
    ['zh', zh, /新开/],
    ['ko', ko, /새 터미널/],
  ] as const)('%s:两种确认文案都点明要在新终端里才能再次授权', (_locale, dict, newTerminal) => {
    for (const key of KEYS) expect(dict[key]).toMatch(newTerminal);
  });

  it('无会话撤销的文案不再笼统地说「之后可重新授权」(现存终端里的 agent 做不到)', () => {
    const key = 'permissions.revoke_all.confirm_grant_only';
    expect(en[key]).not.toMatch(/re-authorize later/i);
    expect(zh[key]).not.toMatch(/之后可重新授权/);
    expect(ko[key]).not.toMatch(/이후 다시 인증할 수 있습니다/);
  });
});
