/**
 * 根域名 WebDAV 面板挂载。
 *
 * 背景：`_middleware.ts` 里的根域名判定刻意排除了 `/api`、`/mcp`、`/share`、
 * `/health`、`/assets` 等产品/静态路径（`isReservedPath`），但**没有**排除
 * 「网页端路由」——也就是 SPA 自己消费的 `/admin/...` 这类路径。
 *
 * 于是当网页端用 `/admin/<虚拟目录>` 做 PROPFIND（文件管理器列目录走的就是
 * 这条路，见 `src/app/transfer.ts` 的 `davHrefToKey`——它只认 `/webdav/`
 * 前缀，因此前端必须请求 /webdav/... 才能正确解析 href）时，
 * 中间件会把它当成「WebDAV 客户端访问根域名」，重写成 `/webdav/admin/...`，
 * 导致 R2 里多出 admin/ 目录、且前端拿到的 href 前缀与预期不符。
 *
 * 结论：根域名直挂只对「真实的 WebDAV 客户端」开放，必须显式排除网页端流量。
 * 本模块集中维护这份豁免清单，供 `_middleware.ts`（路由）与
 * `functions/webdav/protocol.ts`（认证豁免）共用，避免两边判断漂移。
 */

/** 网页端 SPA 路由前缀（对应 src/App.tsx 的哈希路由与 404 回退路径）。 */
export const WEB_UI_ROUTE_PREFIXES = ["/admin"] as const;

/**
 * 会话客户端标识：网页端自己发的 /webdav 请求带这个头（见 src/app/auth.tsx）。
 * 带此头的请求一律不算「WebDAV 客户端」。
 */
export const WEB_UI_CLIENT_HEADER = "X-Davflare-UI";

/** 浏览器导航特征：Sec-Fetch-Mode: navigate 只有顶层文档导航会带。 */
function isDocumentNavigation(request: Request): boolean {
  return (request.headers.get("Sec-Fetch-Mode") || "").toLowerCase() === "navigate";
}

/** 路径是否命中网页端 SPA 路由。 */
export function isWebUiRoutePath(pathname: string): boolean {
  return WEB_UI_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * 该请求是否「来自网页端」——即应当继续交给 SPA / 会话接口处理，
 * 而不是被当成 WebDAV 客户端重写到 /webdav。
 *
 * 判据（任一命中即视为网页端）：
 * 1. 带 `X-Davflare-UI: 1`：网页端自己发的会话请求（含其 `/webdav` PROPFIND），
 *    这是最可靠的信号，见 `src/app/auth.tsx`；
 * 2. `Sec-Fetch-Mode: navigate` + 浏览器 UA：地址栏/链接的顶层文档导航。
 *    只有浏览器会带 `Sec-Fetch-Mode`，任何 WebDAV 客户端都不会；
 *    加上 UA 白名单是为了让该信号可被单测直接构造（jsdom 不注入默认 UA）。
 *
 * 刻意**不**使用「是否带 Authorization」作为判据：真 WebDAV 客户端一定带
 * Basic 凭据，用它做判断会把 rclone 访问 `https://host/admin/` 也误判成
 * 网页端，从而破坏「网盘里名为 admin 的目录」的访问。
 */
export function isWebUiRequest(request: Request): boolean {
  if ((request.headers.get(WEB_UI_CLIENT_HEADER) || "").trim() === "1") {
    return true;
  }
  if (!isDocumentNavigation(request)) {
    return false;
  }
  return /\bmozilla\//i.test(request.headers.get("user-agent") || "");
}

/** 网页端路由 + 网页端流量的组合判定：根域名直挂必须让路。 */
export function isWebUiClientPath(request: Request): boolean {
  return isWebUiRoutePath(new URL(request.url).pathname) && isWebUiRequest(request);
}
