// Marketplace reviews 各项上限的跨进程单一来源(重构:main marketplace-reviews.service 的截断上限与
// renderer reviews-types / reviews-parser / reviews-fetcher 的读端校验上限此前各声明一份,靠注释
// 「对齐 main XXX」维持一致)。写端(main clamp)与读端(renderer 校验 / cache 命中判定)必须同值,
// 否则 main 放行的数据被 renderer 判 cache miss 反复重拉,或 renderer 放行 main 本会截断的超长字段。

export const REVIEW_TITLE_MAX = 1024;
export const REVIEW_BODY_MAX = 16384;
/** url / avatarUrl。 */
export const REVIEW_URL_MAX = 2048;
/** author.login / createdAt 等短字段。 */
export const REVIEW_FIELD_MAX = 512;
/** continuoVersion / pluginVersion(与 manifest VERSION_MAX 对齐)。 */
export const REVIEW_VERSION_MAX = 128;
/** 累计 review 节点上限(main 分页累计、renderer 单插件 / 全局累计 / 单次 IPC nodes 共用)。 */
export const REVIEW_TOTAL_NODES_MAX = 2000;
