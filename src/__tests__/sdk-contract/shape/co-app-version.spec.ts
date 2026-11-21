import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coApp } from '../../../plugins/co-app';

describe('sdk-contract shape: coApp version sync', () => {
  it('T4 keeps APP_VERSION synced with package.json version', () => {
    // Topic-05 lesson: a hard-coded APP_VERSION drift can make plugin runtime
    // compatibility fail while unit tests still pass.
    const pkgUrl = new URL('../../../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf-8')) as { version: string };

    expect(coApp.version).toBe(pkg.version);
  });
});
