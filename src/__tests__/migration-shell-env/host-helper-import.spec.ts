import { describe, it, expect } from 'vitest';
import {
  isAllowedShell,
  getDefaultShell,
  prepareShellIntegrationEnv,
} from '@continuo-terminal/server-node';

describe('shell-env helpers re-exported via @continuo-terminal/server-node', () => {
  it('T19 isAllowedShell is a function', () => {
    expect(typeof isAllowedShell).toBe('function');
  });
  it('T19b isAllowedShell returns boolean for known path', () => {
    expect(typeof isAllowedShell('/bin/zsh')).toBe('boolean');
  });
  it('T20 getDefaultShell returns a non-empty string', () => {
    const s = getDefaultShell();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
  it('T21 prepareShellIntegrationEnv returns { env, cleanup } shape for zsh', async () => {
    const baseEnv = { HOME: '/Users/test', SHELL: '/bin/zsh' };
    const result = await prepareShellIntegrationEnv('/bin/zsh', baseEnv);
    expect(result).toHaveProperty('env');
    expect(result).toHaveProperty('cleanup');
    expect(typeof result.cleanup).toBe('function');
    // zsh skip-path: env should be the base env reference unchanged
    expect(result.env).toBe(baseEnv);
    await result.cleanup();
  });
});
