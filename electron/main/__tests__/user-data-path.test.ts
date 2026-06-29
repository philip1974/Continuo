import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveUserDataPath } from '../user-data-path';

describe('resolveUserDataPath', () => {
  it('honors E2E --user-data-dir before the dev default', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '/tmp/e2e-user-data',
        isDev: true,
        isE2E: true,
      }),
    ).toBe('/tmp/e2e-user-data');
  });

  it('keeps the separate dev userData path outside E2E', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '/tmp/e2e-user-data',
        isDev: true,
        isE2E: false,
      }),
    ).toBe(path.join('/tmp/app-data', 'Continuo Dev'));
  });

  it('leaves packaged userData untouched without an E2E override', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '',
        isDev: false,
        isE2E: false,
      }),
    ).toBeNull();
  });
});
