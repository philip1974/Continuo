import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { xtermWebglAtlasVersionPlugin } from './scripts/vite-xterm-webgl-atlas-version';
import { mainModuleSideEffects } from './scripts/main-bundle-side-effects';
import { milkdownKatexStubPlugin } from './scripts/vite-milkdown-katex-stub';
import { milkdownLinkHrefEsbuildPlugin, milkdownLinkHrefPlugin } from './scripts/vite-milkdown-link-href';
import { cspDevConnectPlugin } from './scripts/vite-csp-dev-connect';

// BUILD_TARGET=pack 时输出到 out-pack/,让 `pnpm build:app` 与 `pnpm dev` 可以并行
// 跑(dev 持续写 out/,builder 读 out-pack/,互不踩盘)。
const OUT_ROOT = process.env.BUILD_TARGET === 'pack' ? 'out-pack' : 'out';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@continuo-terminal/protocol', '@continuo-terminal/server-node'],
        // node-pty 是运行时依赖(dependencies),不 external 的话会被 Rollup 打进 bundle。但它含 .node 原生二进制 +
        // 动态 require("./prebuilds/...") — 必须留给 Electron runtime 解析。
        include: ['node-pty'],
      }),
    ],
    build: {
      outDir: `${OUT_ROOT}/main`,
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        // 性能:server-node 包根经 server.ts(顶层 bin 守卫=副作用)静态拖入完整 MCP SDK;声明其无副作用,
        // main 未用即摇掉(启动包少 ~430KB)。见 scripts/main-bundle-side-effects.ts。
        treeshake: { moduleSideEffects: mainModuleSideEffects },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@continuo-terminal/protocol', '@continuo-terminal/server-node'],
        include: ['node-pty'],
      }),
    ],
    build: {
      outDir: `${OUT_ROOT}/preload`,
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts'),
        // sandbox: true 下 preload 必须是 CJS,否则 runPreloadScript 报 SyntaxError
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    // milkdownKatexStubPlugin:@milkdown 内的 katex 导入换空壳(MilkdownEditor chunk 少 ~260KB);Crepe 的 katex 调用点
    // 都由 milkdown-math 覆盖,公式由懒加载的 katex-render 渲染。mermaid 的 katex 不受影响。⚠ 去掉 configureMarkdownMath 前须移除。
    // cspDevConnectPlugin:仅 dev server 把 HMR 所需的 localhost 来源加进 CSP connect-src(生产不含)。
    plugins: [
      react(),
      tailwindcss(),
      xtermWebglAtlasVersionPlugin(),
      milkdownKatexStubPlugin(),
      milkdownLinkHrefPlugin(),
      cspDevConnectPlugin(),
    ],
    // dev 预打包会绕过 transform,addon-webgl 是无依赖的单文件 ESM,直接走源文件即可;
    // @milkdown/preset-commonmark 与 Crepe 一起预打包,补丁改走 esbuild 插件(milkdownLinkHref)。
    optimizeDeps: {
      exclude: ['@xterm/addon-webgl'],
      esbuildOptions: { plugins: [milkdownLinkHrefEsbuildPlugin()] },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'electron/shared'),
      },
    },
    // Milkdown/Crepe 内部 import Vue ESM bundler build,需 define 三个 flag
    // 否则 console 报 "Feature flags ... not explicitly defined"。
    // LM 不用 Vue,统一 false 让 tree-shake 干净。
    define: {
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    build: {
      outDir: `${OUT_ROOT}/renderer`,
      // electron-vite 2.x 对 renderer 默认 minify:false:首屏必载 main-app chunk 未压缩 ~2.49MB,
      // 压缩后 ~1.27MB,每次冷启动都要完整读取 + 编译(BDD: perf-audit/renderer-minify)。
      minify: 'esbuild',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
  },
});
