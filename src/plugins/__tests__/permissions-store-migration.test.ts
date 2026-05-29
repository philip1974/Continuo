import { describe, expect, it } from 'vitest';
import {
  parsePermissionState,
  serializePermissionState,
} from '../permissions/IpcPermissionStore';

describe('IpcPermissionStore permission state migration', () => {
  it('T4.a deserializes old JSON without pathScopes and writes legacy shape back', () => {
    const oldJson = {
      'com.old': [{ permission: 'fs', granted: true, decidedAt: 1 }],
    };

    const parsed = parsePermissionState(oldJson);

    expect(parsed['com.old']).toEqual({
      decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
    });
    expect(parsed['com.old']?.pathScopes).toBeUndefined();
    expect(serializePermissionState(parsed)).toEqual(oldJson);
  });

  it('T4.b deserializes new JSON with pathScopes and preserves it round-trip', () => {
    const newJson = {
      'com.new': {
        decisions: [{ permission: 'shell', granted: false, decidedAt: 2 }],
        pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
      },
    };

    const parsed = parsePermissionState(newJson);

    expect(parsed['com.new']).toEqual({
      decisions: [{ permission: 'shell', granted: false, decidedAt: 2 }],
      pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
    });
    expect(serializePermissionState(parsed)).toEqual(newJson);
  });

  it('T4.c handles mixed JSON with and without pathScopes independently', () => {
    const mixedJson = {
      'com.legacy': [{ permission: 'network', granted: true, decidedAt: 3 }],
      'com.scoped': {
        decisions: [{ permission: 'clipboard', granted: true, decidedAt: 4 }],
        pathScopes: [{ path: '/tmp/y', mode: 'r' }],
      },
    };

    const parsed = parsePermissionState(mixedJson);

    expect(parsed['com.legacy']).toEqual({
      decisions: [{ permission: 'network', granted: true, decidedAt: 3 }],
    });
    expect(parsed['com.scoped']).toEqual({
      decisions: [{ permission: 'clipboard', granted: true, decidedAt: 4 }],
      pathScopes: [{ path: '/tmp/y', mode: 'r' }],
    });
    expect(serializePermissionState(parsed)).toEqual(mixedJson);
  });

  it('T4.d round-trips pathScopes content exactly', () => {
    const state = parsePermissionState({
      'com.paths': {
        decisions: [{ permission: 'fs', granted: true, decidedAt: 5 }],
        pathScopes: [
          { path: '/tmp/x', mode: 'rw' },
          { path: '/tmp/y', mode: 'r' },
        ],
      },
    });

    const serialized = serializePermissionState(state);
    const reparsed = parsePermissionState(serialized);

    expect(reparsed['com.paths']?.pathScopes).toEqual([
      { path: '/tmp/x', mode: 'rw' },
      { path: '/tmp/y', mode: 'r' },
    ]);
    expect(reparsed).toEqual(state);
  });
});
