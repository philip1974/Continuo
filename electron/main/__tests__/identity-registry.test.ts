import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginIdentityError } from '../../shared/plugin-fs-contract';
import {
  DRAIN_GRACE_MS_FOR_TEST,
  IdentityRegistry,
} from '../services/identity-registry.service';

describe('IdentityRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('T19a register returns unique token and per-plugin monotonic generation', () => {
    const registry = new IdentityRegistry();

    const first = registry.register('com.example.plugin', 10);
    const second = registry.register('com.example.plugin', 10);

    expect(first.token).not.toEqual(second.token);
    expect(first.token).toHaveLength(64);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
  });

  it('T19b resolve happy path returns pluginId and generation', () => {
    const registry = new IdentityRegistry();
    const { token } = registry.register('com.example.plugin', 10);

    expect(registry.resolve(token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 1,
    });
  });

  it('T19c resolve unknown token throws PluginIdentityError', () => {
    const registry = new IdentityRegistry();

    expect(() => registry.resolve('deadbeef', 0)).toThrow(PluginIdentityError);
    expect(() => registry.resolve('deadbeef', 0)).toThrow('unknown token');
  });

  it('T19d resolve senderId mismatch throws PluginIdentityError', () => {
    const registry = new IdentityRegistry();
    const { token } = registry.register('com.example.plugin', 10);

    expect(() => registry.resolve(token, 11)).toThrow(PluginIdentityError);
    expect(() => registry.resolve(token, 11)).toThrow('senderId mismatch');
  });

  it('T19e revoke marks token draining and resolve still works with warning', () => {
    const registry = new IdentityRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { token } = registry.register('com.example.plugin', 10);

    registry.revoke(token);

    expect(registry._peek(token)?.state).toBe('draining');
    expect(registry.resolve(token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      '[identity-registry] resolve on draining token plugin=com.example.plugin gen=1',
    );
  });

  it('T19f HMR grace timing removes token after drain grace', () => {
    const registry = new IdentityRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { token } = registry.register('com.example.plugin', 10);

    expect(registry.resolve(token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 1,
    });

    registry.revoke(token);

    expect(registry.resolve(token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DRAIN_GRACE_MS_FOR_TEST);

    expect(registry._peek(token)).toBeUndefined();
    expect(() => registry.resolve(token, 10)).toThrow(PluginIdentityError);
    expect(() => registry.resolve(token, 10)).toThrow('unknown token');
  });

  it('T19g HMR full flow keeps old draining token and new active token separated', () => {
    const registry = new IdentityRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const oldIdentity = registry.register('com.example.plugin', 10);

    registry.revoke(oldIdentity.token);
    const newIdentity = registry.register('com.example.plugin', 10);

    expect(newIdentity.token).not.toEqual(oldIdentity.token);
    expect(oldIdentity.generation).toBe(1);
    expect(newIdentity.generation).toBe(2);
    expect(registry._peek(oldIdentity.token)?.state).toBe('draining');
    expect(registry._peek(newIdentity.token)?.state).toBe('active');

    expect(registry.resolve(oldIdentity.token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      '[identity-registry] resolve on draining token plugin=com.example.plugin gen=1',
    );
    expect(registry.resolve(newIdentity.token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 2,
    });

    vi.advanceTimersByTime(DRAIN_GRACE_MS_FOR_TEST);

    expect(() => registry.resolve(oldIdentity.token, 10)).toThrow(
      PluginIdentityError,
    );
    expect(registry.resolve(newIdentity.token, 10)).toEqual({
      pluginId: 'com.example.plugin',
      generation: 2,
    });
  });

  it('revokeByWebContents 只把该 webContents 名下 token 送入 drain,宽限期后删除;之后新注册的不受影响', () => {
    const registry = new IdentityRegistry();
    const a = registry.register('com.example.plugin', 10);
    const b = registry.register('com.other.plugin', 10);
    const other = registry.register('com.example.plugin', 11);

    registry.revokeByWebContents(10);
    expect(registry.isActive(a.token)).toBe(false);
    expect(registry.isActive(b.token)).toBe(false);
    expect(registry.isActive(other.token)).toBe(true);

    // reload 后新文档重新注册:不被已发生的撤销波及
    const fresh = registry.register('com.example.plugin', 10);
    vi.advanceTimersByTime(DRAIN_GRACE_MS_FOR_TEST);
    expect(registry._peek(a.token)).toBeUndefined();
    expect(registry._peek(b.token)).toBeUndefined();
    expect(registry.isActive(fresh.token)).toBe(true);
    expect(registry.isActive(other.token)).toBe(true);
  });
});
