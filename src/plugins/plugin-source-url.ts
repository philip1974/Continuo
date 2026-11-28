// 插件入口的稳定 sourceURL(BDD: src/__tests__/plugin-dev-experience/)。
//
// 入口源码经 Blob URL 加载(绕过 file:// 跨进程加载限制),Blob URL 每次加载都不同:堆栈里是 `blob:file:///<uuid>`、
// DevTools 的断点按 URL 记,重载后失效。生成 Blob 前在源码末尾追加 `//# sourceURL=continuo-plugin://<id>/<main>` ——
// V8 用它作脚本名(Error.stack、DevTools 源码树与断点都按它),每次重载同一个地址。地址不可访问(只是名字),
// 相对 sourceMappingURL 由主进程内联成 data URL(plugins.service inlinePluginSourceMap)。

export const PLUGIN_SOURCE_URL_PREFIX = 'continuo-plugin://';

/** manifest 的入口名 → URL 路径段:去掉开头的 `./`,反斜杠换成 `/`,逐段编码(空格、换行等不进注释)。 */
function mainUrlPath(main: string): string {
  return main
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.')
    .map(encodeURIComponent)
    .join('/');
}

export function pluginSourceUrl(pluginId: string, main: string): string {
  return `${PLUGIN_SOURCE_URL_PREFIX}${encodeURIComponent(pluginId)}/${mainUrlPath(main)}`;
}

/** 源码末尾追加 sourceURL 注释(行号不变:只在末尾加行)。 */
export function withPluginSourceUrl(source: string, sourceUrl: string): string {
  return `${source}\n//# sourceURL=${sourceUrl}\n`;
}

// 堆栈帧里的插件位置:`continuo-plugin://<id>/<path>:<line>:<col>`(V8 两种帧格式 `at f (url:l:c)` / `at url:l:c` 都含此串)。
const FRAME_RE = /continuo-plugin:\/\/([^/\s():]+)\/([^\s():]*):(\d+):(\d+)/;

function frameMatch(stack: string, pluginId?: string): RegExpExecArray | null {
  const re = new RegExp(FRAME_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) {
    if (pluginId === undefined || safeDecode(m[1]!) === pluginId) return m;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 错误堆栈里该插件最靠栈顶的帧 → `main.js:8:5`(相对插件目录的文件:行:列);没有 → undefined。 */
export function pluginLocationFromStack(stack: unknown, pluginId: string): string | undefined {
  if (typeof stack !== 'string' || stack.length === 0) return undefined;
  const m = frameMatch(stack.slice(0, 16 * 1024), pluginId);
  return m ? `${safeDecode(m[2]!)}:${m[3]}:${m[4]}` : undefined;
}

/** 错误堆栈里最靠栈顶的插件帧属于哪个插件(未捕获错误归属到插件输出通道用);没有插件帧 → null。 */
export function pluginIdFromStack(stack: unknown): string | null {
  if (typeof stack !== 'string' || stack.length === 0) return null;
  const m = frameMatch(stack.slice(0, 16 * 1024));
  return m ? safeDecode(m[1]!) : null;
}
