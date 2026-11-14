// ```mermaid 代码块在 Preview / Edit 模式渲染成图(真实 mermaid + Crepe + DOMPurify 链路)。
// 单测全是 mock,这里验证真实产物:SVG 落进 DOM、节点文字没被 sanitizer 剥掉。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  editorModeButton,
  editorTab,
  openWorkspaceFile,
} from './helpers/editor';
import { LIGHT_THEME, SETTINGS, SETTINGS_NAV } from './helpers/settings';

const DOCK_EDITOR_TAB = /^(编辑器|Editor|편집기)/;
const SWITCH_ANYWAY = /^(仍然切换|Switch anyway|그래도 전환)$/;
const RENDER_ERROR =
  /(Mermaid 图表渲染失败|Failed to render Mermaid diagram|Mermaid 다이어그램 렌더링 실패)/;

const FLOW = [
  '# Flow',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[结束]',
  '```',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  'tail',
  '',
].join('\n');

const shotDir = process.env['MERMAID_SHOT_DIR'];

test('Preview:mermaid 代码块渲染成 SVG,普通代码块不受影响', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(path.join(workspaceRoot, 'flow.md'), FLOW);
  await openWorkspaceFile(window, ['flow.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  const diagram = window.locator('main .milkdown .preview svg');
  await expect(diagram).toHaveCount(1, { timeout: 15_000 });
  await expect(diagram).toBeVisible();
  // 节点文字在(htmlLabels:false → SVG text,没被 DOMPurify 当 foreignObject 剥掉)
  await expect(diagram).toContainText('开始');
  await expect(diagram).toContainText('判断');
  // 只读预览下只显示图,不显示 mermaid 源码
  const codeBlocks = window.locator('main .milkdown .cm-content');
  await expect(codeBlocks.filter({ hasText: 'graph TD' })).toBeHidden();
  // 普通代码块照常显示源码
  await expect(codeBlocks.filter({ hasText: 'const a = 1;' })).toBeVisible();
  if (shotDir) await window.screenshot({ path: path.join(shotDir, 'preview.png') });
});

test('Edit:源码 + 图同时显示,改源码后图更新,语法错误给出提示', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(path.join(workspaceRoot, 'flow.md'), FLOW);
  await openWorkspaceFile(window, ['flow.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();

  const diagram = window.locator('main .milkdown .preview svg');
  await expect(diagram).toContainText('开始', { timeout: 15_000 });
  const source = window.locator('main .milkdown .cm-content').first();
  await expect(source).toContainText('graph TD');
  if (shotDir) await window.screenshot({ path: path.join(shotDir, 'edit.png') });

  // 在 mermaid 源码末尾加一个节点 → 图里出现新节点
  await source.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('\n  C --> D[新节点]');
  await expect(diagram).toContainText('新节点', { timeout: 10_000 });

  // 写坏语法 → 预览区显示错误提示而不是崩掉
  await window.keyboard.type('\n  D --> --> [');
  await expect(window.locator('main .milkdown .preview')).toContainText(
    RENDER_ERROR,
    { timeout: 10_000 },
  );
  if (shotDir) await window.screenshot({ path: path.join(shotDir, 'error.png') });
  // mermaid 不往 body 遗留自带的错误图
  await expect(window.locator('body > [id^="dcontinuo-mermaid"]')).toHaveCount(0);
});

test('含 frontmatter 的文档:Preview 可用且渲染图;Edit 经确认后可用', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(
    path.join(workspaceRoot, 'doc.md'),
    `---\nid: demo\n---\n${FLOW}`,
  );
  await openWorkspaceFile(window, ['doc.md']);

  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await expect(window.locator('main .milkdown .preview svg')).toContainText(
    '开始',
    { timeout: 15_000 },
  );
  // frontmatter 以代码块展示,没有被解析成标题
  await expect(window.locator('main .milkdown .cm-content').first()).toContainText(
    'id: demo',
  );
  await expect(window.locator('main .milkdown h2')).toHaveCount(0);
  if (shotDir) await window.screenshot({ path: path.join(shotDir, 'frontmatter.png') });

  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  await window.getByRole('button', { name: SWITCH_ANYWAY }).click();
  await expect(window.locator('main .milkdown [contenteditable="true"]').first()).toBeVisible();
  await expect(window.locator('main .milkdown .preview svg')).toContainText('开始', {
    timeout: 15_000,
  });
});

test('Preview:点击 Markdown 链接 / mermaid 节点链接在应用内打开文件,窗口不被导航走', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(
    path.join(workspaceRoot, 'links.md'),
    [
      '[to-a](./src/a.ts)',
      '',
      '```mermaid',
      'flowchart LR',
      '  N[去README] --> M[other]',
      '  click N href "./README.md"',
      '```',
      '',
    ].join('\n'),
  );
  await openWorkspaceFile(window, ['links.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const appUrl = window.url();

  await window.locator('main .milkdown .preview svg a').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });
  expect(window.url()).toBe(appUrl);

  await editorTab(window, 'links.md').click();
  await window.locator('main .milkdown a', { hasText: 'to-a' }).click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });
  expect(window.url()).toBe(appUrl);
});

// 主题可能在输入途中变(跟随系统的自动切换):图就地重画,编辑器不重挂载 → 光标与刚敲的字都在。
test('输入途中切换主题:图按新主题重画,光标和输入不丢', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'flow.md'), FLOW);
  await openWorkspaceFile(window, ['flow.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const diagram = window.locator('main .milkdown .preview svg');
  await expect(diagram).toContainText('开始', { timeout: 15_000 });
  const nodeFill = () =>
    diagram
      .locator('.node rect')
      .first()
      .evaluate((el) => getComputedStyle(el).fill);
  const darkId = await diagram.getAttribute('id');
  const darkFill = await nodeFill();

  const heading = window.locator('main .milkdown h1');
  await heading.click();
  await window.keyboard.type('X');
  // 编辑器保持可见的情况下切主题(设置面板是另一个 dock tab,会把编辑器换下去)
  await window.evaluate(() => {
    (
      window as unknown as {
        __continuoTest: { setSettingValue: (id: string, v: string) => void };
      }
    ).__continuoTest.setSettingValue('general.theme', 'light');
  });
  await window.keyboard.type('Y');
  await expect(window.locator('html')).not.toHaveClass(/dark/, { timeout: 5_000 });

  // 没有重挂载:两次按键落在同一处
  await expect(heading).toContainText('XY');
  // 重画 → 新的 svg id;节点填充色随主题变化,且取自应用 token
  await expect(diagram).not.toHaveAttribute('id', darkId ?? '', { timeout: 15_000 });
  await expect(diagram).toContainText('开始');
  const lightFill = await nodeFill();
  expect(lightFill).not.toBe(darkFill);
  const tokenFill = await window.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue('--md-surface-container-high')
      .trim();
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(lightFill).toBe(tokenFill);
  if (shotDir) await window.screenshot({ path: path.join(shotDir, 'light.png') });

  // 收起再展开预览,不会把旧主题的图换回来
  const toggle = window.locator('main .milkdown .preview-toggle-button').first();
  await window.locator('main .milkdown .milkdown-code-block').first().hover();
  await toggle.click();
  await toggle.click();
  await expect(diagram).toBeVisible();
  expect(await nodeFill()).toBe(lightFill);
});

// 用户真实路径:设置面板是另一个 dock tab,切主题时编辑器在后台(隐藏),回来后图要在且是新主题。
test('在设置面板切主题后回到编辑器,图仍在并按新主题渲染', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'flow.md'), FLOW);
  await openWorkspaceFile(window, ['flow.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const diagram = window.locator('main .milkdown .preview svg');
  await expect(diagram).toContainText('开始', { timeout: 15_000 });
  const darkFill = await diagram
    .locator('.node rect')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);

  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window.getByRole('radio', { name: LIGHT_THEME }).click();
  await expect(window.locator('html')).not.toHaveClass(/dark/, { timeout: 5_000 });

  await window.getByRole('tab', { name: DOCK_EDITOR_TAB }).click();
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  await expect(diagram).toContainText('开始');
  const lightFill = await diagram
    .locator('.node rect')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
  expect(lightFill).not.toBe(darkFill);
  // 后台重画不算编辑:文件不变脏,源码仍可编辑
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
  await expect(window.locator('main .milkdown .cm-content').first()).toContainText('graph TD');
});

// 各图型走的渲染器不同(有的默认用 foreignObject 标签,会被 sanitizer 剥掉),逐个确认文字还在。
test('Preview:时序图 / 类图 / 状态图 / 甘特图 / 带 init 指令的流程图都带文字渲染', async ({
  window,
  workspaceRoot,
}) => {
  const diagrams: Array<{ code: string; text: string }> = [
    { code: 'sequenceDiagram\n  participant A as 用户\n  A->>A: 自言自语', text: '自言自语' },
    { code: 'classDiagram\n  class Animal {\n    +eat() void\n  }', text: 'Animal' },
    { code: 'stateDiagram-v2\n  [*] --> 空闲\n  空闲 --> [*]', text: '空闲' },
    { code: 'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  任务甲 :a1, 2024-01-01, 3d', text: '任务甲' },
    // 图表自带指令想把标签切回 HTML(foreignObject)→ 被 secure 列表忽略,文字仍在
    {
      code: '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  X[指令节点] --> Y',
      text: '指令节点',
    },
  ];
  writeFileSync(
    path.join(workspaceRoot, 'types.md'),
    diagrams.map((d) => `\`\`\`mermaid\n${d.code}\n\`\`\`\n`).join('\n'),
  );
  await openWorkspaceFile(window, ['types.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  const svgs = window.locator('main .milkdown .preview svg');
  await expect(svgs).toHaveCount(diagrams.length, { timeout: 20_000 });
  for (const [i, d] of diagrams.entries()) {
    await expect(svgs.nth(i)).toContainText(d.text);
  }
  await expect(window.locator('main .milkdown .preview foreignObject')).toHaveCount(0);
});

// 逐键完整渲染会让大图里打字卡顿(实测 150 节点的图每键阻塞数秒):连续输入只在停手后渲染一次。
test('Edit:在图源码里连续输入不逐键重画,停手后渲染最后一版', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'flow.md'), FLOW);
  await openWorkspaceFile(window, ['flow.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const diagram = window.locator('main .milkdown .preview svg');
  await expect(diagram).toContainText('开始', { timeout: 15_000 });

  // 记录预览区里出现过的每一张图(每次渲染 svg id 都不同)
  await window.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __mermaidSeen: Set<string> }).__mermaidSeen = seen;
    new MutationObserver(() => {
      const svg = document.querySelector('main .milkdown .preview svg');
      if (svg) seen.add(svg.id);
    }).observe(document.querySelector('main .milkdown')!, { subtree: true, childList: true });
  });
  const source = window.locator('main .milkdown .cm-content').first();
  await source.click();
  await window.keyboard.press('ControlOrMeta+End');
  const typed = '\n  C --> D[abcdefghijklmnopqrstuvwxyz]';
  await window.keyboard.type(typed, { delay: 20 });

  await expect(diagram).toContainText('abcdefghijklmnopqrstuvwxyz', { timeout: 10_000 });
  const renders = await window.evaluate(
    () => (window as unknown as { __mermaidSeen: Set<string> }).__mermaidSeen.size,
  );
  // 36 次按键;逐键渲染的话是几十张图。留一点余量给机器卡顿时的中途停顿。
  expect(renders).toBeGreaterThanOrEqual(1);
  expect(renders).toBeLessThanOrEqual(5);
});
