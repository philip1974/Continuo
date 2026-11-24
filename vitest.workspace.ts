import { defineWorkspace } from 'vitest/config';
import { milkdownLinkHrefPlugin } from './scripts/vite-milkdown-link-href';
// @ts-expect-error mjs 共享配置,无 .d.ts
import { CONTRACT_INCLUDE, INTEGRATION_INCLUDE } from './scripts/test-categories.mjs';

// 历史:下列规范经 electron/main 服务间接 import electron,曾因 Actions 上缺 Electron 二进制
//(require('electron') 抛 "Electron failed to install correctly")在全部 CI 平台排除。
// 现状:根 postinstall 先跑 `install-electron`(CI 的 `pnpm install --frozen-lockfile` 会执行根
// lifecycle 脚本,仓库未设 ignore-scripts),且 Electron 45 的 index.js 缺二进制时还会自行下载,
// 故 ubuntu 已恢复运行。Windows 仍排除:这些规范从未在 Windows CI 跑过,其中不少依赖 POSIX
// shell / 路径语义,需先在 Windows runner 上逐个验证再放开。
const CI_WINDOWS_UNVERIFIED = Boolean(process.env.CI) && process.platform === 'win32';

const CI_ELECTRON_UNIT_EXCLUDE = CI_WINDOWS_UNVERIFIED
  ? [
      'src/__tests__/dock-layout-per-window-seq/safe-handle-ctx.spec.ts',
      'src/__tests__/fs-ipc-bridge/fs-ipc-bridge.spec.ts',
      'src/__tests__/ipc-safe-handle/safe-handle.spec.ts',
      'src/__tests__/migration-step2-buffer-merge/exited-session-replay.spec.ts',
      'src/__tests__/migration-step2-buffer-merge/replay-completeness.spec.ts',
      'src/__tests__/shell-service/shell-service.spec.ts',
      'src/__tests__/terminal-service/helpers.spec.ts',
      'src/__tests__/terminal-workspace-isolation/workspaceRoot-roundtrip.spec.ts',
      'src/__tests__/window-workspace-roots-map/cwd-fallback-error.spec.ts',
      'src/__tests__/i18n-set-locale-commit-gen/commit-gen.spec.ts',
      'src/__tests__/plugins-ipc-input-limits/plugins-ipc-input-limits.spec.ts',
      'src/__tests__/shell-exec-input-limits/exec-input-limits.spec.ts',
      'src/__tests__/terminal-create-cancel-orphan/create-cancel-orphan.spec.ts',
      // topic-49/50 打磨与安全审计新增:经 electron/main 服务间接 import electron
      'src/__tests__/49-polish-bugfixes/external-url-scheme-whitelist.spec.ts',
      'src/__tests__/49-polish-bugfixes/read-git-blob-bounds.spec.ts',
      'src/__tests__/49-polish-bugfixes/security-file-url-trust.spec.ts',
      'src/__tests__/49-polish-bugfixes/shell-exec-cjk-bytes.spec.ts',
      'src/__tests__/49-polish-bugfixes/shell-exec-timeout-clamp.spec.ts',
      'src/__tests__/49-polish-bugfixes/shell-stream-abort.spec.ts',
      'src/__tests__/49-polish-bugfixes/shell-stream-frame-trust.spec.ts',
      'src/__tests__/49-polish-bugfixes/shell-stream-reload-kills-children.spec.ts',
      'src/__tests__/49-polish-bugfixes/stdio-stale-window-binding.spec.ts',
      'src/__tests__/49-polish-bugfixes/stop-hook-window-close.spec.ts',
      'src/__tests__/49-polish-bugfixes/terminal-create-reserve-before-spawn.spec.ts',
    ]
  : [];

const CI_ELECTRON_CONTRACT_EXCLUDE = CI_WINDOWS_UNVERIFIED
  ? [
      'src/__tests__/agent-terminal-mcp-stdio-framing/framing.spec.ts',
      'src/__tests__/sdk-contract/integration/plugin-fs.service.spec.ts',
      'src/__tests__/sdk-contract/integration/shell.service.spec.ts',
      // 间接 import electron(plugin-shell-stream.service),与上两条同源
      'src/__tests__/sdk-contract/integration/plugin-shell-stream.service.spec.ts',
    ]
  : [];

const CI_ELECTRON_INTEGRATION_EXCLUDE = CI_WINDOWS_UNVERIFIED
  ? [
      'src/__tests__/terminal-ipc/read-history-ownership.spec.ts',
      'src/__tests__/terminal-ipc/terminal-ipc.spec.ts',
      'src/__tests__/terminal-window-isolation/terminal-window-isolation.spec.ts',
    ]
  : [];

const CI_WINDOWS_UNIT_EXCLUDE =
  process.env.CI && process.platform === 'win32'
    ? [
        'src/__tests__/ct-b3-socket-safety/socket-safety.spec.ts',
        'src/__tests__/i18n-strings-r2/hardcode-regression.spec.ts',
        'src/__tests__/migration-step2-buffer-merge/no-dangling-import.spec.ts',
        // POSIX-only 测试设定在 Windows 不成立:
        // - atomic:chmod 0o500 只读目录在 Windows 不阻止建 .tmp → 写成功不抛
        // - canonicalize:正斜杠分隔符 / symlink 需管理员 / 临时目录短名(RUNNER~1)
        // 产品代码于 macOS/Linux(应用运行平台)正确,ubuntu job 仍覆盖。
        'src/__tests__/49-polish-bugfixes/plugin-fs-writefile-atomic.spec.ts',
        'src/__tests__/49-polish-bugfixes/scope-grant-canonicalizes-path.spec.ts',
      ]
    : [];

// 三档语义见 scripts/test-categories.mjs:
//   contract:稳定外部契约层
//   integration:跨进程 / 多窗口 / IPC 纵向链路
//   unit:其余全部
//
// src/integration/ 是占位,future 纵向链路用例搬入。

// 需要 renderer 构建期补丁的 Milkdown 规范(真实 Crepe 跑打过补丁的 @milkdown 产物)。补丁只在 vite transform
// 里生效,@milkdown 须 inline,且要整组 inline —— 只 inline preset-commonmark 会与 Node 原生加载的
// kit / crepe 各持一份实例。inline 后首次加载 Crepe 明显变慢,故单独成 project,不拖慢其它用到 Crepe 的规范。
const MILKDOWN_PATCHED_INCLUDE = [
  'src/__tests__/editor-markdown-link-href/**/*.spec.ts',
  'src/__tests__/editor-markdown-ime-composition/**/*.spec.ts',
];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      exclude: [
        ...INTEGRATION_INCLUDE,
        ...CONTRACT_INCLUDE,
        ...MILKDOWN_PATCHED_INCLUDE,
        ...CI_ELECTRON_UNIT_EXCLUDE,
        ...CI_WINDOWS_UNIT_EXCLUDE,
      ],
    },
  },
  {
    extends: './vitest.config.ts',
    plugins: [milkdownLinkHrefPlugin()],
    test: {
      name: 'milkdown-patched',
      include: MILKDOWN_PATCHED_INCLUDE,
      server: { deps: { inline: [/[\\/]@milkdown[\\/]/] } },
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: INTEGRATION_INCLUDE,
      exclude: CI_ELECTRON_INTEGRATION_EXCLUDE,
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'contract',
      include: CONTRACT_INCLUDE,
      exclude: CI_ELECTRON_CONTRACT_EXCLUDE,
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'electron',
      include: ['electron/**/*.{spec,test}.{ts,tsx}', 'electron/**/*.bench.ts'],
    },
  },
]);
