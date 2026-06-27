import { describe, expect, it } from 'vitest';
import { defaultShellArgs, shellFamilyForPath } from '../services/shell-args';

describe('defaultShellArgs — 跨平台默认 shell 参数', () => {
  it('zsh / bash / fish 给 login+interactive (-l -i)', () => {
    expect(defaultShellArgs('/bin/zsh')).toEqual(['-l', '-i']);
    expect(defaultShellArgs('/usr/bin/bash')).toEqual(['-l', '-i']);
    expect(defaultShellArgs('/opt/homebrew/bin/fish')).toEqual(['-l', '-i']);
  });

  it('Windows powershell / pwsh / cmd 不加 -l -i(会启动失败)', () => {
    expect(defaultShellArgs('powershell.exe')).toEqual([]);
    expect(defaultShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual(
      [],
    );
    expect(defaultShellArgs('C:\\Windows\\System32\\cmd.exe')).toEqual([]);
  });

  it('/bin/sh 及未知 shell 不加(dash 不支持 -l,未知 shell 保守不加)', () => {
    expect(defaultShellArgs('/bin/sh')).toEqual([]);
    expect(defaultShellArgs('/usr/bin/some-exotic-shell')).toEqual([]);
  });

  it('大小写不敏感,容忍 .exe 后缀', () => {
    expect(defaultShellArgs('C:\\msys64\\usr\\bin\\BASH.EXE')).toEqual([
      '-l',
      '-i',
    ]);
  });
});

describe('shellFamilyForPath — 由 shell 路径推断引号族', () => {
  it('powershell / pwsh → powershell', () => {
    expect(shellFamilyForPath('powershell.exe')).toBe('powershell');
    expect(
      shellFamilyForPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    ).toBe('powershell');
  });
  it('cmd → cmd', () => {
    expect(shellFamilyForPath('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
  });
  it('zsh/bash/fish/sh / 未知 → posix', () => {
    expect(shellFamilyForPath('/bin/zsh')).toBe('posix');
    expect(shellFamilyForPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(
      'posix',
    );
    expect(shellFamilyForPath('/bin/sh')).toBe('posix');
    expect(shellFamilyForPath('/usr/bin/exotic')).toBe('posix');
  });
});
