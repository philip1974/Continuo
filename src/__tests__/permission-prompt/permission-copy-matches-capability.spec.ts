// 授权弹窗里每项权限的说明须如实反映实际能力(用户据此决定是否授权)。行为见同目录 README「权限说明文案」。
// 这里钉的是「必须点明的事实」,不钉整句措辞。
import { describe, expect, it } from 'vitest';
import { en } from '../../../electron/shared/i18n-locales/en';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { PERM_LABEL_KEYS } from '@/plugins/permissions/perm-labels';

const catalogs = { en, zh, ko } as Record<string, Record<string, string>>;
const desc = (locale: string, perm: keyof typeof PERM_LABEL_KEYS): string =>
  catalogs[locale]![PERM_LABEL_KEYS[perm].descKey]!;

describe('权限说明文案与实际能力一致', () => {
  it('shell:可运行任意程序,不受文件夹授权限制,等同完全访问文件与网络', () => {
    expect(desc('en', 'shell')).toMatch(/any program/i);
    expect(desc('en', 'shell')).toMatch(/not limited by folder access/i);
    expect(desc('en', 'shell')).toMatch(/full access to your files and network/i);
    expect(desc('zh', 'shell')).toMatch(/任意程序/);
    expect(desc('zh', 'shell')).toMatch(/不受文件夹授权限制/);
    expect(desc('zh', 'shell')).toMatch(/完全访问本机文件与网络/);
    expect(desc('ko', 'shell')).toMatch(/임의의 프로그램/);
    expect(desc('ko', 'shell')).toMatch(/폴더 권한의 제한을 받지 않/);
    expect(desc('ko', 'shell')).toMatch(/전체 액세스/);
  });

  it('network:任意 https 地址,包括本机(localhost)与内网;不再声称 HTTP / WebSocket', () => {
    for (const locale of ['en', 'zh', 'ko']) {
      expect(desc(locale, 'network')).toMatch(/https/);
      expect(desc(locale, 'network')).toMatch(/localhost/);
      expect(desc(locale, 'network')).not.toMatch(/WebSocket|HTTP /);
    }
    expect(desc('en', 'network')).toMatch(/local network/i);
    expect(desc('zh', 'network')).toMatch(/内网/);
    expect(desc('ko', 'network')).toMatch(/내부 네트워크/);
  });

  it('fs:只在用户批准的文件夹内', () => {
    expect(desc('en', 'fs')).toMatch(/folders you approve/i);
    expect(desc('zh', 'fs')).toMatch(/你批准的文件夹/);
    expect(desc('ko', 'fs')).toMatch(/승인한 폴더/);
  });

  it('mcp-tools:工具名称与描述会展示给 AI agent 并可被其调用', () => {
    expect(desc('en', 'mcp-tools')).toMatch(/names and descriptions are shown to AI agents/i);
    expect(desc('en', 'mcp-tools')).toMatch(/call/i);
    expect(desc('zh', 'mcp-tools')).toMatch(/名称与描述会展示给 AI Agent/);
    expect(desc('zh', 'mcp-tools')).toMatch(/调用/);
    expect(desc('ko', 'mcp-tools')).toMatch(/이름과 설명이 AI Agent/);
    expect(desc('ko', 'mcp-tools')).toMatch(/호출/);
  });
});
