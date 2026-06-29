export const PERMISSION_GRANT_SELECTED =
  /^(授权选中（\d+）|Grant selected \(\d+\)|선택 허용 \(\d+\))$/;

export const PERMISSION_DENY_ALL = /^(全部拒绝|Deny all|모두 거부)$/;
export const PERMISSION_LABEL_FS = /^(文件系统|File system|파일 시스템)$/;
export const PERMISSION_LABEL_NETWORK =
  /^(网络访问|Network access|네트워크 액세스)$/;
export const PERMISSION_LABEL_CLIPBOARD = /^(剪贴板|Clipboard|클립보드)$/;

export const permissionGrantSelectedText = (count: number) =>
  new RegExp(
    `^(授权选中（${count}）|Grant selected \\(${count}\\)|선택 허용 \\(${count}\\))$`,
  );
