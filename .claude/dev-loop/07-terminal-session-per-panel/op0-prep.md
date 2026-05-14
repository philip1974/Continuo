# topic-07 Op0 prep: importer + Cmd+T 冲突清单

## 1. importer 清单

命令:

```sh
grep -rn "PaneController\|paneTree\|panelReducer\|TAB_DRAG_MIME\|tab-drag-payload\|TerminalPanelPlugin" src
```

### src/core-plugins/TerminalPanelPlugin.ts

```text
4:export default class TerminalPanelPlugin extends Plugin {
```

### src/core-plugins/index.ts

```text
12:import TerminalPanelPlugin from './TerminalPanelPlugin';
38:    Cls: TerminalPanelPlugin as never,
```

### src/shell/dock/DockShell.tsx

```text
22:import { TAB_DRAG_MIME, decodeTabDragPayload, type TabDragPayload } from '@/lib/tab-drag-payload';
24:import { getPaneController } from '@/panels/Terminal/PaneControllerRegistry';
60:  const controller = getPaneController(currentWindowId, payload.sourcePanelId);
257:        if (!Array.from(types).includes(TAB_DRAG_MIME)) return;
```

### src/shell/dock/wrap-panel-close.ts

```text
5:import { getPaneController } from '@/panels/Terminal/PaneControllerRegistry';
57:  const controller = getPaneController(coApi.system.windowId, panel.api.id);
```

### src/shell/dock/HeaderActions.tsx

```text
9:  getPaneController,
10:  subscribePaneControllers,
11:} from '@/panels/Terminal/PaneControllerRegistry';
38:    () => subscribePaneControllers(() => setControllerVersion((n) => n + 1)),
104:    !!getPaneController(coApi.system.windowId, activePanelId);
```

### src/panels/Terminal/TerminalPaneTree.tsx

```text
2:import type { PanelAction } from './panelReducer';
3:import type { PaneNode, SplitDirection } from './paneTree';
6:import { TAB_DRAG_MIME, decodeTabDragPayload } from '@/lib/tab-drag-payload';
7:import { getPaneController } from './PaneControllerRegistry';
62:    if (Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) {
92:    const sourceController = getPaneController(windowId, payload.sourcePanelId);
```

### src/panels/Terminal/panelReducer.ts

```text
5:  paneTreeReducer,
11:} from './paneTree';
22:} from './paneTree';
27:  paneTree: PaneNodePersisted;
29:  paneTreeVersion: 1;
42:  paneTree: PaneNode;
45:  paneTreeVersion: 1;
77:  | { type: 'TAB_DETACHED'; tabId: string; leafSnapshot: import('./paneTree').LeafNode }
125:export function panelReducer(
138:        collectLeaves(tab.paneTree).map<PanelEffect>((leaf) => ({
165:        collectPtyIdsFromPane(t.paneTree).includes(action.ptyId),
185:        paneTree: leaf,
188:        paneTreeVersion: 1,
213:      // V1 限制:只允许 detach paneTree 是单 leaf 的 tab(split tab 拖动太复杂,
215:      if (tab.paneTree.kind !== 'leaf') {
223:      const leafSnapshot = tab.paneTree;
251:        paneTree: leaf,
254:        paneTreeVersion: 1,
279:      const ptyIds = collectPtyIdsFromPane(tab.paneTree);
303:      const result = paneTreeReducer(
304:        { tree: tab.paneTree, activeLeafId: tab.activeLeafId },
309:        const ptyIds = collectPtyIdsFromPane(tab.paneTree);
329:        paneTree: result.tree,
349:    paneTree: serializePaneNode(tab.paneTree),
351:    paneTreeVersion: 1,
358:  return state.tabs.flatMap((tab) => collectPtyIdsFromPane(tab.paneTree));
377:        paneTreeVersion: 1,
378:        paneTree: { kind: 'leaf', id: 'leaf-default', cwd },
385:  const paneTree = hydratePaneNode(tab.paneTree);
389:    paneTree,
391:      collectLeaves(paneTree).find((leaf) => leaf.id === tab.primaryLeafId)?.id ??
392:      collectLeaves(paneTree)[0]?.id,
394:    paneTreeVersion: 1,
401:  effects: import('./paneTree').PaneTreeEffect[],
```

### src/panels/Terminal/PaneSplitter.tsx

```text
3:import type { PanelAction } from './panelReducer';
4:import type { SplitDirection } from './paneTree';
```

### src/panels/Terminal/PaneControllerRegistry.ts

```text
8:} from './panelReducer';
9:import { findLeaf, type LeafNode, type SplitDirection } from './paneTree';
29:export interface PaneController {
49:export interface CreatePaneControllerInput {
61:const controllers = new Map<string, PaneController>();
64:export function createPaneController({
72:}: CreatePaneControllerInput): PaneController {
74:  const controller: PaneController = {
87:      const leaf = findLeaf(tab.paneTree, tab.activeLeafId);
165:export function registerPaneController(
168:  controller: PaneController,
181:export function getPaneController(
184:): PaneController | undefined {
188:export function getPaneControllersForWindow(windowId: number): PaneController[] {
194:export function subscribePaneControllers(listener: Listener): () => void {
201:export function _clearPaneControllerRegistryForTest(): void {
```

### src/panels/Terminal/useTerminal.ts

```text
25:import { getPaneController, type PaneController } from './PaneControllerRegistry';
191:        const ctrl = getPaneController(coApi.system.windowId, paneOpts.panelId);
338:  controller: Pick<PaneController, 'dispatch' | 'split' | 'focusPrev' | 'focusNext'>,
```

### src/panels/Terminal/TerminalPanel.tsx

```text
25:  createPaneController,
26:  registerPaneController,
27:  getPaneController,
28:  type PaneController,
29:} from './PaneControllerRegistry';
32:  panelReducer,
37:} from './panelReducer';
48:  TAB_DRAG_MIME,
52:} from '@/lib/tab-drag-payload';
127:    useDispatchWithEffects(panelReducer, initial);
141:  const controllerRef = useRef<PaneController | null>(null);
143:    controllerRef.current = createPaneController({
156:    () => registerPaneController(controller.windowId, controller.panelId, controller),
220:      if (!Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) return;
224:      const paneTreeEl = elem.closest(`[data-terminal-tab-id]`) as HTMLElement | null;
225:      if (!paneTreeEl) return;
227:      const tabIdOnEl = paneTreeEl.dataset.terminalTabId;
235:      if (!Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) return;
238:      const paneTreeEl = elem.closest(`[data-terminal-tab-id]`) as HTMLElement | null;
239:      if (!paneTreeEl) return;
240:      const tabIdOnEl = paneTreeEl.dataset.terminalTabId;
265:      const sourceCtrl = getPaneController(wId, payload.sourcePanelId);
424:          paneKind: tab.paneTree.kind,
450:          if (tab.paneTree.kind !== 'leaf') {
455:          const leaf = tab.paneTree;
471:          event.dataTransfer.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload));
484:              tree={tab.paneTree}
591:  const fixPane = (node: import('./paneTree').PaneNodePersisted): import('./paneTree').PaneNodePersisted => {
599:    tabs: persisted.tabs.map((tab) => ({ ...tab, paneTree: fixPane(tab.paneTree) })),
```

### src/panels/Terminal/spawnLeaf.ts

```text
2:import type { PanelAction } from './panelReducer';
3:import type { SpawnReason } from './paneTree';
```

### src/panels/Terminal/TerminalLeaf.tsx

```text
2:import type { LeafNode } from './paneTree';
3:import type { PanelAction } from './panelReducer';
```

### src/panels/Terminal/useDispatchWithEffects.ts

```text
30:  // 让 caller(如 PaneController.detachTab)拿到本次 action 的 effects 后直接消费,
```

### src/panels/Terminal/paneTree.ts

```text
131:export function paneTreeReducer(
```

### src/__tests__/terminal-tab-drag-split/detach-suppresses-panel-empty-for-move.spec.ts

```text
7:import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
19:        paneTreeVersion: 1,
20:        paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1', cwd: '/a' },
28:    const result = panelReducer(singleTabState(), {
40:    const result = panelReducer(singleTabState(), {
50:  it('rejects DETACH_TAB on split-tab paneTree (V1 limit)', () => {
60:          paneTreeVersion: 1,
61:          paneTree: {
72:    const result = panelReducer(state, {
86:    const result = panelReducer(singleTabState(), {
```

### src/__tests__/terminal-tab-drag-split/tab-limit.spec.ts

```text
7:import { PANEL_TAB_LIMIT, panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
18:      paneTreeVersion: 1 as const,
19:      paneTree: { kind: 'leaf' as const, id: `leaf-${i}`, ptyId: `pty-${i}` },
31:    const result = panelReducer(state, {
48:    const result = panelReducer(state, {
```

### src/__tests__/terminal-tab-drag-split/popout-rejects-cross-window.spec.ts

```text
6: * 这层是 DockShell + tab-drag-payload 的协同 invariant。本 spec 锁
12:  TAB_DRAG_MIME,
16:} from '../../lib/tab-drag-payload';
53:    dt.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload));
```

### src/__tests__/terminal-tab-drag-split/agent-control-link-stable.spec.ts

```text
12:import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
24:        paneTreeVersion: 1,
25:        paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-codex' },
35:    const result = panelReducer(singleTabState(), {
44:    const result = panelReducer(singleTabState(), {
53:    const result = panelReducer(singleTabState(), {
```

### src/__tests__/terminal-tab-drag-split/pty-not-restarted.spec.ts

```text
7:import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
8:import { paneTreeReducer } from '../../panels/Terminal/paneTree';
13:    const result = panelReducer(state, {
33:          paneTreeVersion: 1,
34:          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
38:    const result = panelReducer(state, {
49:    const result = paneTreeReducer(
```

### src/__tests__/terminal-tab-drag-split/attach-rejected-reverse-notify.spec.ts

```text
12:  panelReducer,
15:} from '../../panels/Terminal/panelReducer';
26:      paneTreeVersion: 1 as const,
27:      paneTree: { kind: 'leaf' as const, id: `leaf-${i}`, ptyId: `pty-${i}` },
34:    const result = panelReducer(makeFull(), {
59:          paneTreeVersion: 1,
60:          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-dup' },
64:    const result = panelReducer(state, {
```

### src/__tests__/terminal-tab-drag-split/README.md

```text
12:  消失，paneTree 出现新 SplitNode，该 session 成为目标 leaf 的兄弟。
23:  全局 effectQueue），让 `PaneController.detachTab` 拿到 `leafSnapshot`。
24:- **Split-tab dragstart 拒**: tab.paneTree.kind === 'split' 时 onDragStart `event.preventDefault()`
39:- 复用 topic-03 `panels/Terminal/paneTree.ts` 的 `LeafNode` / `SplitNode` / `mapTree` 等
41:- 复用 topic-03 `panelReducer` 现有 `ADD_TAB` / `CLOSE_TAB` / `SELECT_TAB` / `PANE_ACTION`。
```

### src/__tests__/terminal-tab-drag-split/dispatch-and-collect-sync-effects.spec.ts

```text
3: * 产生的 effects(不进 effectQueueRef)。让 PaneController.detachTab 同步拿
```

### src/__tests__/terminal-tab-drag-split/drop-attach-as-leaf.spec.ts

```text
8:  paneTreeReducer,
11:} from '../../panels/Terminal/paneTree';
23:    const result = paneTreeReducer(
48:    const result = paneTreeReducer(
66:    const result = paneTreeReducer(
```

### src/__tests__/terminal-tab-drag-split/preflight-rejects-over-limit.spec.ts

```text
14:  panelReducer,
16:} from '../../panels/Terminal/panelReducer';
27:      paneTreeVersion: 1 as const,
28:      paneTree: { kind: 'leaf' as const, id: `leaf-${i}`, ptyId: `pty-${i}` },
36:    const result = panelReducer(state, {
54:    const result = panelReducer(fullState(), {
```

### src/__tests__/terminal-tab-drag-split/agent-attach.spec.ts

```text
2: * R1: agent 用 MCP 建出的 session 在 200ms 内通过 panelReducer
7:import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
15:    const result = panelReducer(emptyHydratedState(), {
31:    expect(tab?.paneTree.kind).toBe('leaf');
32:    if (tab?.paneTree.kind === 'leaf') {
33:      expect(tab.paneTree.ptyId).toBe('pty-from-mcp');
34:      expect(tab.paneTree.spawnPending).toBe(false);
52:          paneTreeVersion: 1,
53:          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-dup' },
57:    const result = panelReducer(state, {
```

### src/__tests__/terminal-tab-drag-split/split-tab-dragstart-rejected.spec.ts

```text
2: * P1-6: split-tab(paneTree.kind === 'split')的 tab 在 dragstart 阶段被拒绝。
3: * 实际实施在 TerminalPanel.tsx 的 onTabDragStart callback — 检 tab.paneTree.kind
11:import type { TabState } from '../../panels/Terminal/panelReducer';
14:  it('TabState.paneTree.kind === "leaf" indicates draggable tab', () => {
20:      paneTreeVersion: 1,
21:      paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
23:    expect(tab.paneTree.kind).toBe('leaf');
26:  it('TabState.paneTree.kind === "split" indicates NOT draggable', () => {
32:      paneTreeVersion: 1,
33:      paneTree: {
42:    expect(tab.paneTree.kind).toBe('split');
```

### src/__tests__/terminal-tab-drag-split/drop-promote-to-scoped.spec.ts

```text
3: * - tab-drag-payload encode/decode round-trip
10:import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
12:  TAB_DRAG_MIME,
16:} from '../../lib/tab-drag-payload';
45:          paneTreeVersion: 1,
46:          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-orig', cwd: '/repo' },
53:          paneTreeVersion: 1,
54:          paneTree: { kind: 'leaf', id: 'leaf-2', ptyId: 'pty-2' },
58:    const result = panelReducer(state, {
75:  it('tab-drag-payload encode/decode round-trip', () => {
87:    dt.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload));
97:    dt.setData(TAB_DRAG_MIME, 'not-json');
99:    dt.setData(TAB_DRAG_MIME, JSON.stringify({ version: 99 }));
```

### src/__tests__/terminal-workspace-isolation/workspaceRoot-roundtrip.spec.ts

```text
5:// 端到端验,renderer 端的 render filter 在 panelReducer 主题的 spec 验。
```

### src/__tests__/terminal-workspace-isolation/README.md

```text
57:- `normalizePersistedCwd(persisted, fallback)`:遍历 panel paneTree,leaf 上
67:| `src/panels/Terminal/panelReducer.ts` | `TabState.workspaceRoot` 在 ADD_TAB / HYDRATE / ATTACH 路径上的写入与 ENQUEUE_SPAWN 继承 |
```

### src/__tests__/terminal-pane-internal-split/pane-tree-reducer.spec.ts

```text
6:  paneTreeReducer,
9:} from '../../panels/Terminal/paneTree';
22:describe('paneTreeReducer', () => {
70:    const result = paneTreeReducer(
95:    const result = paneTreeReducer(
111:    const result = paneTreeReducer(
125:    const result = paneTreeReducer(
137:    const result = paneTreeReducer(
148:    const result = paneTreeReducer(
161:    const result = paneTreeReducer(
173:    const result = paneTreeReducer(
182:    const result = paneTreeReducer(
191:    const next = paneTreeReducer(
195:    const prev = paneTreeReducer(
205:    const high = paneTreeReducer(
209:    const low = paneTreeReducer(
219:    const result = paneTreeReducer(
```

### src/__tests__/terminal-pane-internal-split/hydrate-then-spawn-order.spec.ts

```text
5:} from '../../panels/Terminal/paneTree';
7:  panelReducer,
9:} from '../../panels/Terminal/panelReducer';
29:    const result = panelReducer(
40:              paneTreeVersion: 1,
41:              paneTree: tree,
48:    expect(collectLeaves(result.state.tabs[0]!.paneTree).map((l) => l.id)).toEqual([
64:    const hydrated: PanelState = panelReducer(
75:              paneTreeVersion: 1,
76:              paneTree: tree,
83:    const result = panelReducer(hydrated, {
89:    expect(collectLeaves(result.state.tabs[0]!.paneTree).find((l) => l.id === 'leaf-b')?.ptyId).toBe(
```

### src/__tests__/terminal-pane-internal-split/reducer-pure-with-effects.spec.ts

```text
3:  panelReducer,
5:} from '../../panels/Terminal/panelReducer';
11:    const result = panelReducer(emptyState, {
20:            paneTreeVersion: 1,
21:            paneTree: { kind: 'leaf', id: 'leaf-1', cwd: '/repo' },
45:    const result = panelReducer({ ...emptyState, hydrated: true }, {
74:          paneTreeVersion: 1,
75:          paneTree: { kind: 'leaf', id: 'leaf-1' },
82:          paneTreeVersion: 1,
83:          paneTree: { kind: 'leaf', id: 'leaf-2' },
88:    const result = panelReducer(state, { type: 'SELECT_TAB', tabId: 'tab-2' });
```

### src/__tests__/terminal-pane-internal-split/effect-three-levels-tab-vs-panel.spec.ts

```text
3:  panelReducer,
5:} from '../../panels/Terminal/panelReducer';
17:        paneTreeVersion: 1,
18:        paneTree: {
32:        paneTreeVersion: 1,
33:        paneTree: { kind: 'leaf', id: 'leaf-c', ptyId: 'pty-c' },
41:    const began = panelReducer(state(), {
47:    const result = panelReducer(began, {
61:    const began = panelReducer(state(), {
67:    const result = panelReducer(began, {
83:    const began = panelReducer(onlyTab, {
88:    const result = panelReducer(began, {
```

### src/__tests__/terminal-pane-internal-split/panel-reducer.spec.ts

```text
4:  panelReducer,
7:} from '../../panels/Terminal/panelReducer';
19:        paneTreeVersion: 1,
20:        paneTree: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a', cwd: '/a' },
27:        paneTreeVersion: 1,
28:        paneTree: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b', cwd: '/b' },
34:describe('panelReducer', () => {
43:          paneTreeVersion: 1,
44:          paneTree: { kind: 'leaf', id: 'leaf-default', cwd: '/repo' },
51:    const result = panelReducer(
61:    const result = panelReducer(twoTabState(), {
84:    const result = panelReducer(twoTabState(), { type: 'CLOSE_TAB', tabId: 'tab-2' });
93:    const result = panelReducer(twoTabState(), { type: 'CLOSE_TAB', tabId: 'tab-1' });
101:    const result = panelReducer(state, { type: 'CLOSE_TAB', tabId: 'tab-1' });
111:    const result = panelReducer(twoTabState(), {
142:          paneTreeVersion: 1,
143:          paneTree: { kind: 'leaf', id: 'leaf-a', cwd: '/a' },
149:          paneTreeVersion: 1,
150:          paneTree: { kind: 'leaf', id: 'leaf-b', cwd: '/b' },
159:    const result = panelReducer(
178:    const result = panelReducer(
196:    const result = panelReducer(
207:              paneTreeVersion: 1,
208:              paneTree: { kind: 'leaf', id: 'leaf-h', cwd: '/proj-b' },
233:          paneTreeVersion: 1,
234:          paneTree: { kind: 'leaf', id: 'leaf-1', cwd: '/x', ptyId: 'pty-1' },
246:    const result = panelReducer(base, {
```

### src/__tests__/terminal-pane-internal-split/controller-identity-stable-via-ref.spec.ts

```text
3:  createPaneController,
4:  registerPaneController,
5:} from '../../panels/Terminal/PaneControllerRegistry';
6:import type { PanelState } from '../../panels/Terminal/panelReducer';
21:            paneTreeVersion: 1,
22:            paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
27:    const controller = createPaneController({
36:    const unregister = registerPaneController(7, 'panel-1', controller);
49:          paneTreeVersion: 1,
50:          paneTree: { kind: 'leaf', id: 'leaf-2', ptyId: 'pty-2' },
63:    const controller = createPaneController({
80:              paneTreeVersion: 1,
81:              paneTree: {
```

### src/__tests__/tab-split-panes/hotkey-no-conflict.spec.ts

```text
6:    const mod = await import('../../core-plugins/TerminalPanelPlugin');
```

### src/lib/split-terminal.ts

```text
7:import { getPaneController } from '@/panels/Terminal/PaneControllerRegistry';
8:import type { SplitDirection } from '@/panels/Terminal/paneTree';
```

### src/lib/tab-drag-payload.ts

```text
1:export const TAB_DRAG_MIME = 'application/x-continuo-terminal-tab';
22:  const raw = dataTransfer.getData(TAB_DRAG_MIME);
```

## 2. split-terminal 直接 importer

命令:

```sh
grep -rn "from '@/lib/split-terminal'\|from \"@/lib/split-terminal\"\|require.*split-terminal" src
```

Op8 若整删 `src/lib/split-terminal.ts`，需要先改这些 direct import:

### src/core-plugins/TerminalPanelPlugin.ts

```text
2:import { focusTerminalPane, splitTerminal } from '@/lib/split-terminal';
```

### src/shell/dock/HeaderActions.tsx

```text
5:import { splitTerminal } from '@/lib/split-terminal';
```

## 3. Cmd+T 冲突结论

命令:

```sh
grep -rn "hotkey:.*['\"]mod+t['\"]" src
```

结果: 无命中。

结论: OK 可用 mod+t。
