// BDD: external-link-trusted-domains / main 外链出口:不受信的 http(s) 链接先弹原生确认框(VSCode trustedDomainsValidator),
// 「信任 <域名>」写入 userData/trusted-domains.json;mailto 与受信链接直接打开;文件损坏时隔离留证、抢救有效条目后照常保存;
// 读不出来(IO)时不覆盖,并在确认框里写明「本次修改不会保存」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Box {
  message?: string;
  detail?: string;
  buttons: string[];
  cancelId?: number;
}

const h = vi.hoisted(() => ({
  userData: '',
  opened: [] as string[],
  boxes: [] as Box[],
  responses: [] as number[],
  clipboard: [] as string[],
  menuCommands: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getLocale: () => 'en-US' },
  shell: {
    openExternal: vi.fn(async (u: string) => {
      h.opened.push(u);
    }),
  },
  dialog: {
    showMessageBox: vi.fn(async (...args: unknown[]) => {
      h.boxes.push(args[args.length - 1] as Box);
      return { response: h.responses.shift() ?? 0, checkboxChecked: false };
    }),
  },
  clipboard: { writeText: (s: string) => h.clipboard.push(s) },
  BrowserWindow: class {},
  webContents: {},
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({
  sendMenuCommand: (_win: unknown, id: string) => {
    h.menuCommands.push(id);
    return true;
  },
}));

import { openExternalIfAllowed } from '../../../electron/main/services/shell.service';
import {
  _resetTrustedDomainsForTest,
  getUserTrustedDomains,
  isTrustedDomainsPersistBlocked,
  setUserTrustedDomains,
} from '../../../electron/main/services/trusted-domains.service';
import { en } from '../../../electron/shared/i18n-locales/en';

const file = () => path.join(h.userData, 'trusted-domains.json');

beforeEach(() => {
  h.userData = mkdtempSync(path.join(tmpdir(), 'trusted-domains-'));
  h.opened = [];
  h.boxes = [];
  h.responses = [];
  h.clipboard = [];
  h.menuCommands = [];
  _resetTrustedDomainsForTest();
});
afterEach(() => rmSync(h.userData, { recursive: true, force: true }));

describe('不受信的 http(s) 链接:先确认', () => {
  it('确认框:「是否要让 Continuo 打开外部网站?」+ 完整地址;按钮 打开 / 复制 / 配置受信任的域 / 取消', async () => {
    h.responses = [3];
    const url = 'https://evil.example/login?next=%2Fhome&a=b#frag';
    await expect(openExternalIfAllowed(url)).resolves.toBe(true);
    expect(h.boxes).toHaveLength(1);
    expect(h.boxes[0]!.message).toBe('Do you want Continuo to open the external website?');
    expect(h.boxes[0]!.detail).toBe(url);
    expect(h.boxes[0]!.buttons).toEqual([
      en['link.confirm.open'],
      en['link.confirm.copy'],
      en['link.confirm.configure'],
      en['link.confirm.cancel'],
    ]);
    expect(h.boxes[0]!.cancelId).toBe(3);
    expect(h.opened).toEqual([]); // 取消 → 不打开,也不算失败
  });

  it('打开 → 交系统打开', async () => {
    h.responses = [0];
    await openExternalIfAllowed('https://evil.example/x');
    expect(h.opened).toEqual(['https://evil.example/x']);
  });

  it('复制 → 地址进剪贴板,不打开', async () => {
    h.responses = [1];
    await openExternalIfAllowed('https://evil.example/x');
    expect(h.clipboard).toEqual(['https://evil.example/x']);
    expect(h.opened).toEqual([]);
  });

  it('地址显示为规范化 href:国际化域名显示 punycode(同形字一眼可辨)', async () => {
    h.responses = [3];
    await openExternalIfAllowed('https://exаmple.com/'); // а = U+0430
    expect(h.boxes[0]!.detail).toBe('https://xn--exmple-4nf.com/');
  });

  it('配置受信任的域 → 信任 <源>:写入持久化,随即打开,之后同源不再询问', async () => {
    h.responses = [2, 0];
    await openExternalIfAllowed('https://docs.example.com/a');
    expect(h.boxes[1]!.buttons.slice(0, 3)).toEqual([
      'Trust https://docs.example.com',
      'Trust example.com and all its subdomains',
      'Trust all domains (disables link protection)',
    ]);
    expect(h.opened).toEqual(['https://docs.example.com/a']);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, domains: ['https://docs.example.com'] });
    await openExternalIfAllowed('https://docs.example.com/b');
    expect(h.boxes).toHaveLength(2);
    expect(h.opened).toHaveLength(2);
    // 别的子域仍要确认
    h.responses = [3];
    await openExternalIfAllowed('https://www.example.com/');
    expect(h.boxes).toHaveLength(3);
  });

  it('配置受信任的域 → 信任域名及其所有子域', async () => {
    h.responses = [2, 1];
    await openExternalIfAllowed('https://docs.example.com/a');
    expect(await getUserTrustedDomains()).toEqual(['*.example.com']);
    await openExternalIfAllowed('https://www.example.com/');
    expect(h.boxes).toHaveLength(2);
    expect(h.opened).toHaveLength(2);
  });

  it('配置受信任的域 → 管理受信任的域:打开设置页那一项,不打开链接', async () => {
    h.responses = [2, 3];
    await openExternalIfAllowed('https://docs.example.com/a');
    expect(h.menuCommands).toEqual(['workbench.action.manageTrustedDomain']);
    expect(h.opened).toEqual([]);
  });
});

describe('无需确认', () => {
  it('默认受信(本应用仓库)、localhost、用户已信任的 → 直接打开', async () => {
    await setUserTrustedDomains(['*.trusted.test']);
    await openExternalIfAllowed('https://github.com/philip1974/Continuo/issues');
    await openExternalIfAllowed('http://localhost:5173/');
    await openExternalIfAllowed('https://a.trusted.test/x');
    expect(h.boxes).toEqual([]);
    expect(h.opened).toHaveLength(3);
  });

  it('mailto 不走受信域名(VSCode 只校验 http / https)', async () => {
    await openExternalIfAllowed('mailto:a@b.test');
    expect(h.boxes).toEqual([]);
    expect(h.opened).toEqual(['mailto:a@b.test']);
  });

  it('白名单外的 scheme 仍直接拒绝(不弹框)', async () => {
    await expect(openExternalIfAllowed('javascript:alert(1)')).resolves.toBe(false);
    expect(h.boxes).toEqual([]);
  });
});

describe('持久化', () => {
  const restart = () => _resetTrustedDomainsForTest();

  it('读出已存的列表', async () => {
    writeFileSync(file(), JSON.stringify({ version: 1, domains: ['https://saved.test'] }));
    expect(await getUserTrustedDomains()).toEqual(['https://saved.test']);
    expect(await isTrustedDomainsPersistBlocked()).toBe(false);
  });

  it('JSON 损坏 → 原文件隔离为 .corrupt 留证、按空列表询问;之后信任的域照常保存,重启后还在', async () => {
    writeFileSync(file(), '{oops');
    expect(await getUserTrustedDomains()).toEqual([]);
    expect(readFileSync(`${file()}.corrupt`, 'utf8')).toBe('{oops');
    expect(await isTrustedDomainsPersistBlocked()).toBe(false);
    await setUserTrustedDomains(['https://new.test']);
    restart();
    expect(await getUserTrustedDomains()).toEqual(['https://new.test']);
  });

  it('格式不符(条目超长 / 非字符串 / 版本不对)→ 隔离留证,抢救出合法条目并立即写回;重启后仍在', async () => {
    const bad = { version: 2, domains: ['https://keep.test', 42, 'x'.repeat(300), ' https://keep2.test '] };
    writeFileSync(file(), JSON.stringify(bad));
    expect(await getUserTrustedDomains()).toEqual(['https://keep.test', 'https://keep2.test']);
    expect(JSON.parse(readFileSync(`${file()}.corrupt`, 'utf8'))).toEqual(bad);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, domains: ['https://keep.test', 'https://keep2.test'] });
    restart();
    expect(await getUserTrustedDomains()).toEqual(['https://keep.test', 'https://keep2.test']);
  });

  it('再次损坏不覆盖更早的 .corrupt 证据', async () => {
    writeFileSync(file(), '{first');
    await getUserTrustedDomains();
    restart();
    writeFileSync(file(), '{second');
    await getUserTrustedDomains();
    const evidence = readdirSync(h.userData).filter((f) => f.startsWith('trusted-domains.json.corrupt'));
    expect(evidence).toHaveLength(2);
    expect(readFileSync(`${file()}.corrupt`, 'utf8')).toBe('{first');
  });

  it('读不出来(IO 错误,内容未知)→ 按空列表询问、本次不写盘;「配置受信任的域」对话框写明本次修改不会保存', async () => {
    mkdirSync(file()); // 路径是目录:读失败(非损坏)
    expect(await getUserTrustedDomains()).toEqual([]);
    expect(await isTrustedDomainsPersistBlocked()).toBe(true);
    h.responses = [2, 0];
    await openExternalIfAllowed('https://docs.example.com/a');
    expect(h.boxes[1]!.detail).toBe(`https://docs.example.com/a\n\n${en['settings.trusted_domains.not_saved']}`);
    expect(h.opened).toEqual(['https://docs.example.com/a']); // 本次运行内存里生效
    expect(readdirSync(file())).toEqual([]);
    expect(existsSync(`${file()}.corrupt`)).toBe(false);
  });

  it('正常时「配置受信任的域」对话框不带该提示', async () => {
    h.responses = [2, 3];
    await openExternalIfAllowed('https://docs.example.com/a');
    expect(h.boxes[1]!.detail).toBe('https://docs.example.com/a');
  });
});
