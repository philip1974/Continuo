import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// BUILD_TARGET=pack 时输出到 out-pack/,让 `pnpm build:app` 与 `pnpm dev` 可以并行
// 跑(dev 持续写 out/,builder 读 out-pack/,互不踩盘)。
const OUT_ROOT = process.env.BUILD_TARGET === 'pack' ? 'out-pack' : 'out';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: `${OUT_ROOT}/main`,
      rollupOptions: { input: resolve(__dirname, 'electron/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react(), tailwindcss()],
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
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
  },
});
