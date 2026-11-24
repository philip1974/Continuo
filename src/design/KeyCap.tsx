// 统一快捷键展示组件。
// 参考 stitch_desktop_design_reviewer 原型,border + 2px outset 营造 3D 键帽感。

import type { ReactNode } from 'react';
import './KeyCap.css';

export interface KeyCapProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}

export function KeyCap({ children, className, title }: KeyCapProps) {
  return (
    <kbd
      className={className ? `wm-keycap ${className}` : 'wm-keycap'}
      title={title}
    >
      {children}
    </kbd>
  );
}
