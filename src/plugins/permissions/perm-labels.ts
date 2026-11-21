// topic-21: PERM_LABELS_KEYS — PermissionPrompt + PermissionEditorModal 共享。
// 值是 i18n catalog key，render 时 useT() 解码。

import type { PermissionKey } from '../permissions';

export const PERM_LABEL_KEYS: Record<
  PermissionKey,
  { titleKey: string; descKey: string }
> = {
  fs: {
    titleKey: 'permissions.perm.fs.title',
    descKey: 'permissions.perm.fs.desc',
  },
  network: {
    titleKey: 'permissions.perm.network.title',
    descKey: 'permissions.perm.network.desc',
  },
  shell: {
    titleKey: 'permissions.perm.shell.title',
    descKey: 'permissions.perm.shell.desc',
  },
  clipboard: {
    titleKey: 'permissions.perm.clipboard.title',
    descKey: 'permissions.perm.clipboard.desc',
  },
  'mcp-tools': {
    titleKey: 'permissions.perm.mcp_tools.title',
    descKey: 'permissions.perm.mcp_tools.desc',
  },
};
