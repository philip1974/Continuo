import { afterEach, describe, expect, it } from 'vitest';
import { foldPathForCompare } from '../lib/file-identity';

const NFC = '/Users/x/Café';
const NFD = '/Users/x/Café';
const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => setPlatform(realPlatform));

describe('foldPathForCompare', () => {
  it('Linux(大小写与规范化形式都敏感):原样返回', () => {
    setPlatform('linux');
    expect(foldPathForCompare(NFD)).toBe(NFD);
    expect(foldPathForCompare('/A/B')).toBe('/A/B');
  });

  it.each(['darwin', 'win32'] as const)('%s:折叠大小写与 Unicode 规范化形式(NFC + 小写)', (platform) => {
    setPlatform(platform);
    expect(foldPathForCompare(NFD)).toBe('/users/x/café');
    expect(foldPathForCompare(NFD)).toBe(foldPathForCompare(NFC.toUpperCase()));
  });
});
