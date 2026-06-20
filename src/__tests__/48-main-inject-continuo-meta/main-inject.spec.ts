import { describe, expect, it } from 'vitest';
import {
  buildCommonWebPreferences,
  buildContinuoPackagedArg,
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

  it('returns a fresh webPreferences object for each window', () => {
    const first = buildCommonWebPreferences();
    const second = buildCommonWebPreferences();

    expect(first === second).toBe(false);
    expect(first.additionalArguments === second.additionalArguments).toBe(false);
  });
});
