export const PERMISSION_GRANT_SELECTED =
  /^(授权选中（\d+）|Grant selected \(\d+\)|선택 허용 \(\d+\))$/;

export const PERMISSION_DENY_ALL = /^(全部拒绝|Deny all|모두 거부)$/;

export const permissionGrantSelectedText = (count: number) =>
  new RegExp(
    `^(授权选中（${count}）|Grant selected \\(${count}\\)|선택 허용 \\(${count}\\))$`,
  );
