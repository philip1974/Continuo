import { describe, expect, it } from 'vitest';
import {
  buildCommonWebPreferences,
  buildContinuoPackagedArg,
  buildContinuoHostnameArg,
} from '../../../electron/main/continuo-meta-args';

describe('topic 48 main packaged metadata injection', () => {
  it('serializes unpackaged state as a renderer argument', () => {
    expect(buildContinuoPackagedArg(false)).toBe('--continuo-packaged=false');
  });

  it('serializes packaged state as a renderer argument', () => {
    expect(buildContinuoPackagedArg(true)).toBe('--continuo-packaged=true');
  });

  it('adds the Continuo packaged argument to common webPreferences', () => {
    expect(
      buildCommonWebPreferences().additionalArguments?.some((arg) =>
        arg.startsWith('--continuo-packaged='),
      ),
    ).toBe(true);
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
