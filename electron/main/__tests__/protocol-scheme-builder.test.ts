// 深链 scheme 单一来源:代码侧用 shared PROTOCOL_SCHEME,打包配置 electron-builder.yml 无法 import,
// 这里钉住两者一致(否则安装包注册的 scheme 与 main / renderer 识别的不同,深链全失效)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_SCHEME } from '../../shared/plugins-channels';

describe('electron-builder protocols.schemes', () => {
  it('与 PROTOCOL_SCHEME 一致', () => {
    const yml = readFileSync(path.resolve(__dirname, '../../../electron-builder.yml'), 'utf-8');
    const m = /schemes:\s*\n((?:\s*-\s*\S+\s*\n)+)/.exec(yml);
    expect(m).not.toBeNull();
    const schemes = m![1]!.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    expect(schemes).toEqual([PROTOCOL_SCHEME]);
  });
});
