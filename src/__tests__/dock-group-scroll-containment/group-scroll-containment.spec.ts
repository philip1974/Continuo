// BDD:dock 组不随面板内容滚动(标签栏固定,只滚内容)。见同目录 README。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../styles/dockview.css'), 'utf8');

/** 取选择器(逐字)对应规则块的声明体;不存在 → undefined。 */
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1];
}

describe('dock 组滚动收口', () => {
  it('面板内容区 .dv-content-container 是定位容器(position: relative),绝对定位元素不逃到外层视图', () => {
    expect(ruleBody('.dv-content-container')).toMatch(/position:\s*relative/);
  });

  it('分栏视图 .dv-view 不是滚动容器(overflow: clip),内容撑不滚它', () => {
    expect(ruleBody('.dv-split-view-container > .dv-view-container > .dv-view')).toMatch(/overflow:\s*clip/);
  });
});
