// renderer 入口:先按主题设置同步定好 <html> 的 dark class(首帧不闪色,见 theme/initial-theme.ts),
// 再动态 import main-app 并启动。严格 m.init() 调用(不用 m.init?.())。
import { applyInitialThemeClass } from './theme/initial-theme';

applyInitialThemeClass();
void import('./main-app').then((m) => m.init());

export {};
