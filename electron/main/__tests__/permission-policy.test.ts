// 安全:Chromium 权限默认拒绝(此前未设 handler → Electron 默认放行所有权限,renderer 内插件 /
// XSS 可直接 getUserMedia / geolocation / Notification / clipboard-read 绕过插件权限模型)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetTrustedRendererFileForTest,
  setTrustedDevOrigin,
  setTrustedRendererFile,
} from '../safe-handle';
import {
  installPermissionHandlers,
  isPermissionAllowed,
} from '../lib/permission-policy';

const ENTRY = '/Applications/Continuo.app/Contents/Resources/app/out-pack/renderer/index.html';
const TRUSTED = `file://${ENTRY}`;
const DENIED = [
  'media',
  'geolocation',
  'notifications',
  'fullscreen',
  'openExternal',
  'display-capture',
  'pointerLock',
  'keyboardLock',
  'midi',
  'midiSysex',
  'idle-detection',
  'window-management',
  'storage-access',
  'fileSystem',
  'hid',
  'serial',
  'usb',
  'unknown',
];

// Electron 类型声明里权限名的完整联合(Electron 45 / Chromium 156)。Record 要求键集与联合完全一致:
// 升级 Electron 新增 / 改名权限时 typecheck:test 失败,强制在此复核新权限是否仍应默认拒绝
// (例:Electron 45 起屏幕捕获改报 'display-capture',不再混在 'media' 里;Chromium LNA 的
// 'local-network-access' 等)。
type ElectronPermission = Parameters<
  NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
>[1];
const ALL_ELECTRON_PERMISSIONS: Record<ElectronPermission, true> = {
  ar: true,
  'automatic-fullscreen': true,
  'background-fetch': true,
  'background-sync': true,
  'captured-surface-control': true,
  'clipboard-read': true,
  'clipboard-sanitized-write': true,
  'deprecated-sync-clipboard-read': true,
  'display-capture': true,
  fileSystem: true,
  fullscreen: true,
  geolocation: true,
  'geolocation-approximate': true,
  'hand-tracking': true,
  hid: true,
  'idle-detection': true,
  keyboardLock: true,
  'local-fonts': true,
  'local-network': true,
  'local-network-access': true,
  'loopback-network': true,
  media: true,
  mediaKeySystem: true,
  midi: true,
  midiSysex: true,
  nfc: true,
  notifications: true,
  openExternal: true,
  'payment-handler': true,
  'periodic-background-sync': true,
  'persistent-storage': true,
  pointerLock: true,
  'screen-wake-lock': true,
  sensors: true,
  serial: true,
  'smart-card': true,
  'speaker-selection': true,
  'storage-access': true,
  'system-wake-lock': true,
  'top-level-storage-access': true,
  usb: true,
  vr: true,
  'web-app-installation': true,
  'web-printing': true,
  'window-management': true,
  unknown: true,
};

beforeEach(() => {
  _resetTrustedRendererFileForTest();
  setTrustedRendererFile(ENTRY);
  setTrustedDevOrigin(null);
});
afterEach(() => {
  _resetTrustedRendererFileForTest();
  setTrustedDevOrigin(null);
});

describe('isPermissionAllowed', () => {
  it('受信 renderer 入口(含 popout query/hash)+ 剪贴板读写 → 放行', () => {
    for (const url of [TRUSTED, `${TRUSTED}?popout=1`, `${TRUSTED}#/x`]) {
      expect(isPermissionAllowed('clipboard-read', url)).toBe(true);
      expect(isPermissionAllowed('clipboard-sanitized-write', url)).toBe(true);
    }
  });

  it('不受信来源 → 拒(含攻击者写盘的 file:// 页、外部站点、缺失 URL)', () => {
    for (const url of [
      'file:///tmp/evil.html',
      'file:///tmp/index.html',
      'https://evil.example/',
      'about:blank',
      '',
      undefined,
    ]) {
      expect(isPermissionAllowed('clipboard-read', url)).toBe(false);
      expect(isPermissionAllowed('clipboard-sanitized-write', url)).toBe(false);
    }
  });

  it('未列入白名单的权限即使来自受信入口也拒(摄像头/麦克风/定位/通知等)', () => {
    for (const p of DENIED) {
      expect(isPermissionAllowed(p, TRUSTED)).toBe(false);
    }
  });

  it('Electron 全部权限名中只有剪贴板读写放行,其余(含新版新增)从受信入口请求也拒', () => {
    const allowed = Object.keys(ALL_ELECTRON_PERMISSIONS).filter((p) =>
      isPermissionAllowed(p, TRUSTED),
    );
    expect(allowed.sort()).toEqual(['clipboard-read', 'clipboard-sanitized-write']);
  });

  it('dev:index.ts 注入的 dev origin 同源放行,异源拒', () => {
    setTrustedDevOrigin('http://localhost:5173');
    expect(isPermissionAllowed('clipboard-read', 'http://localhost:5173/?windowSeq=1')).toBe(true);
    expect(isPermissionAllowed('clipboard-read', 'http://localhost:5174/')).toBe(false);
    expect(isPermissionAllowed('media', 'http://localhost:5173/')).toBe(false);
  });
});

describe('installPermissionHandlers', () => {
  function install() {
    const ses = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    };
    installPermissionHandlers(ses as never);
    return {
      request: ses.setPermissionRequestHandler.mock.calls[0]![0] as (
        wc: unknown,
        p: string,
        cb: (ok: boolean) => void,
        d: { requestingUrl?: string; isMainFrame: boolean },
      ) => void,
      check: ses.setPermissionCheckHandler.mock.calls[0]![0] as (
        wc: unknown,
        p: string,
        origin: string,
        d: { requestingUrl?: string; isMainFrame: boolean },
      ) => boolean,
      device: ses.setDevicePermissionHandler.mock.calls[0]![0] as (d: unknown) => boolean,
    };
  }

  it('request handler:受信剪贴板放行,media / 不受信来源拒', () => {
    const { request } = install();
    const cb = vi.fn();
    request(null, 'clipboard-sanitized-write', cb, { requestingUrl: TRUSTED, isMainFrame: true });
    request(null, 'media', cb, { requestingUrl: TRUSTED, isMainFrame: true });
    request(null, 'clipboard-read', cb, { requestingUrl: 'https://evil.example/', isMainFrame: false });
    expect(cb.mock.calls).toEqual([[true], [false], [false]]);
  });

  it('check handler:同判定;跨源子 frame 无 requestingUrl → 拒', () => {
    const { check } = install();
    expect(check(null, 'clipboard-read', 'file://', { requestingUrl: TRUSTED, isMainFrame: true })).toBe(true);
    expect(check(null, 'geolocation', 'file://', { requestingUrl: TRUSTED, isMainFrame: true })).toBe(false);
    expect(check(null, 'clipboard-read', 'https://evil.example', { isMainFrame: false })).toBe(false);
  });

  it('device handler 一律拒', () => {
    expect(install().device({})).toBe(false);
  });

  it('index.ts 在 whenReady 内、首窗创建前对 defaultSession 注册', () => {
    const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    const ready = src.indexOf('app.whenReady()');
    const reg = src.indexOf('installPermissionHandlers(session.defaultSession)');
    const firstWin = src.indexOf('createMainWindow({', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(reg).toBeGreaterThan(ready);
    expect(reg).toBeLessThan(firstWin);
  });
});
