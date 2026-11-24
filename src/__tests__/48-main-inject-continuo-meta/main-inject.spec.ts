import { describe, expect, it } from 'vitest';
import {
  buildCommonWebPreferences,
  buildContinuoHostnameArg,
} from '../../../electron/main/continuo-meta-args';

describe('topic 48 main renderer metadata injection', () => {
  // plugin-isolation spike 删除后不再注入 packaged 状态(唯一消费者已不存在)。
  it('does not add a packaged argument to common webPreferences', () => {
    expect(
      buildCommonWebPreferences().additionalArguments?.some((arg) =>
        arg.startsWith('--continuo-packaged='),
      ),
    ).toBe(false);
  });

  // OSC7:shell 发 `file://<真实 hostname>$PWD`,renderer(sandbox)拿不到 os.hostname,
  // 经同一 additionalArguments 通道注入。
  it('serializes the machine hostname as a renderer argument', () => {
    expect(buildContinuoHostnameArg('my-mac.local')).toBe('--continuo-hostname=my-mac.local');
  });

  it('adds the hostname argument (explicit or os.hostname()) to common webPreferences', () => {
    expect(
      buildCommonWebPreferences({ hostname: 'box' }).additionalArguments,
    ).toContain('--continuo-hostname=box');
    expect(
      buildCommonWebPreferences().additionalArguments?.some((arg) =>
        arg.startsWith('--continuo-hostname='),
      ),
    ).toBe(true);
  });

  it('returns a fresh webPreferences object for each window', () => {
    const first = buildCommonWebPreferences();
    const second = buildCommonWebPreferences();

    expect(first === second).toBe(false);
    expect(first.additionalArguments === second.additionalArguments).toBe(false);
  });
});
