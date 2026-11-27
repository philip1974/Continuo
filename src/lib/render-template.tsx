import { Fragment, type ReactNode } from 'react';

/**
 * 按 `{name}` 占位把整句文案切成文本与节点(键帽 / 命令名等)。标点与间距由各语言的整句模板决定(zh 全角标点、ko 助词
 * 紧贴前一段),组件不在片段之间补空格 / flex 间距。未知占位原样保留。
 */
export function renderTemplate(template: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return template.split(/(\{[a-z]+\})/).map((part, i) => {
    const name = /^\{[a-z]+\}$/.test(part) ? part.slice(1, -1) : '';
    const node = name && Object.hasOwn(nodes, name) ? nodes[name] : undefined;
    return <Fragment key={i}>{node ?? part}</Fragment>;
  });
}
