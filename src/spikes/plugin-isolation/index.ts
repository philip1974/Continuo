import { runIframeProbe } from './iframe-probe';
import { runSabProbe } from './sab-probe';
import type { SpikeResult } from './types';
import { runWorkerProbe } from './worker-probe';

declare global {
  interface Window {
    __continuoSpikeResult?: SpikeResult;
    // appIsPackaged 三态:true/false=已知,null=参数缺失/畸形(unknown)。
    // 必须含 null —— preload(electron/preload/index.ts)暴露的就是 boolean|null,
    // README v2-C 把 unknown≠false 作为核心契约,消费方不得把 null 坍缩成 false。
    __continuoMeta?: { appIsPackaged?: boolean | null };
  }
}

export async function run(): Promise<void> {
  console.info('[spike] start');
  const root = document.createElement('div');
  root.id = 'continuo-spike-root';
  document.body.appendChild(root);

  const worker = await runWorkerProbe();
  const iframeResult = await runIframeProbe();
  const sab = await runSabProbe();

  const result: SpikeResult = {
    worker,
    iframe: iframeResult.main,
    iframeInline: iframeResult.inline,
    sab,
    meta: {
      appIsPackaged: window.__continuoMeta?.appIsPackaged ?? null,
      locationProtocol: location.protocol,
      cspContent: readCspMeta(),
      timestamp: new Date().toISOString(),
    },
  };

  window.__continuoSpikeResult = result;
  root.textContent = JSON.stringify(result, null, 2);
  console.info('[spike] done', result);
}

function readCspMeta(): string | null {
  return (
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? null
  );
}

