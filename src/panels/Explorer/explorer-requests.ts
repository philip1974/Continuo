// 命令 / 打开文件夹流程 → FolderTree 的请求通道(新建输入框、把焦点交给文件树)。
// 带挂起语义(不用 coApp.events 的即发即弃广播):侧栏启动即关闭时文件树尚未挂载(ExplorerSidebar 不保活没显示过的
// 树)、打开文件夹后新 root 的文件树要等重挂载,请求挂起到 FolderTree 挂载订阅时取走。
// BDD: src/__tests__/explorer-commands/

import { pathEquals } from '@/lib/path-cross';

export type ExplorerRequest =
  /** 在树焦点项所在目录打开新建输入框。 */
  | { readonly kind: 'create'; readonly type: 'file' | 'dir' }
  /** 焦点交给 root 这棵树(加载完成后:焦点行 / 空文件夹提示 / 读取失败的重试按钮)。 */
  | { readonly kind: 'focusTree'; readonly root: string }
  /** 全部折叠 / 刷新(同标题栏按钮;命令 collapseExplorerFolders / refreshFilesExplorer)。 */
  | { readonly kind: 'collapseAll' | 'refresh' };

/** 处理请求;返回 false = 不归自己(如 root 不符),请求继续挂起。 */
type RequestHandler = (request: ExplorerRequest) => boolean;

let pending: ExplorerRequest | null = null;
const handlers = new Set<RequestHandler>();

/** 发请求:已挂载的文件树立即处理;没人处理则挂起(后到的覆盖先到的),等文件树挂载时取走。 */
export function requestExplorer(request: ExplorerRequest): void {
  pending = request;
  for (const handler of handlers) {
    if (handler(request)) {
      pending = null;
      return;
    }
  }
}

/** FolderTree 订阅请求;订阅时先处理挂起的请求。 */
export function onExplorerRequest(handler: RequestHandler): () => void {
  handlers.add(handler);
  if (pending !== null && handler(pending)) pending = null;
  return () => {
    handlers.delete(handler);
  };
}

/** 请求是否给 root 这棵树(focusTree 只认同一 root;其余总是给当前树)。 */
export function isRequestForRoot(request: ExplorerRequest, root: string): boolean {
  return request.kind !== 'focusTree' || pathEquals(request.root, root);
}

/** 测试用:清掉挂起的请求。 */
export function __resetExplorerRequestsForTest(): void {
  pending = null;
}
