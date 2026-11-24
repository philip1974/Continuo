// 应用版本 = package.json 的 version(renderer 侧单一来源:插件 minLMVersion 准入、市场更新检查)。
// 此前手写常量、发版须与 package.json 两处同步,漏改即让声明新 minLMVersion 的插件被静默跳过。
// JSON 按名导入,构建只内联该字段。
import { version } from '../../package.json';

export const APP_VERSION: string = version;
