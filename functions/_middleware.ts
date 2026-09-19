import {
  WEB_UI_ROUTE_PREFIXES,
  isWebUiClientPath,
} from "./_davroute";
import { gateDriveProductRoute, loadFeatureFlags } from "./_flags";
import { onRequest as davOnRequest } from "./webdav/protocol";
import {
  imageObjectKey,
  imageResponseHeaders,
  resolveSitesHostRoute,
} from "./_images";
import {
  indexFallbackKey,
  isSitesHost,
  loadSiteConfig,
  siteNotFoundKey,
  siteSpaKey,
  sitesNotFound,
  sitesNotFoundPage,
  sitesResponse,
} from "./_sites";

interface MiddlewareEnv {
  BUCKET: R2Bucket;
  SITES_HOST?: string;
  // 根域名直挂会直接调用 WebDAV 处理器，因此这里必须声明 DAV 凭据绑定。
  // 用非可选 string 以对齐 WebDavEnv，避免 env 类型不兼容（TS2345）；
  // 运行时缺失凭据由 handleRequest 自行 fail-closed（403），类型上不做保证。
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
  WEBDAV_PUBLIC_READ?: string;
}

const WEBDAV_METHODS = new Set([
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "PUT",
  "DELETE",
  "OPTIONS",
]);

const WEBDAV_CLIENT_UA = /Microsoft-WebDAV|OneNote|FileExplorer|WebDAVFS|WebDAVLib|DavClnt|WinSCP|rclone|Sardine|Cyberduck|Mountain Duck|Transmit|davfs|gvfs|cadaver|litmus|CarotDAV|RAIDrive|NetDrive/i;

function isReservedPath(pathname: string): boolean {
  return ["/webdav", "/api", "/mcp", "/share", "/health"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  ) || [
    "/assets/",
    "/favicon.ico",
    "/favicon.png",
    "/manifest.json",
    "/robots.txt",
    "/logo144.png",
    "/logo192.png",
  ].some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/** 网页端 SPA 路由（/admin...）：交给静态资源 + index.html 回退，永不当 WebDAV。 */
function isWebUiPath(pathname: string): boolean {
  return WEB_UI_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const ROOT_DAV_PROBE_HEADERS = ["depth", "destination", "overwrite", "lock-token", "timeout"];

/**
 * GET / HEAD 是标准 HTTP 方法，浏览器和 WebDAV 客户端都会发，仅凭请求本身
 * 无法判定。带 WebDAV 特征（UA / Depth 等头）时可直接断定；但不少客户端
 * 下载时只带 Authorization，此时用「凭据 + 路径在 R2 中真实存在」共同裁决：
 * 命中才交给 WebDAV 处理器，否则放行静态资源层——这样浏览器打开 / 或
 * /admin 依然拿到 SPA，不会被直挂截走。
 */
const AMBIGUOUS_METHODS = new Set(["GET", "HEAD"]);

function hasDavCredentials(request: Request): boolean {
  const authorization = request.headers.get("authorization") || "";
  return /^(basic|bearer)\s+\S+/i.test(authorization);
}

/** 查 R2 判断该路径是否真实存在（对象或目录前缀）。 */
async function rootPathExists(bucket: R2Bucket, pathname: string): Promise<boolean> {
  let key: string;
  try {
    key = decodeURIComponent(
      pathname === "/" ? "" : pathname.replace(/^\//, "").replace(/\/$/, ""),
    );
  } catch {
    key = pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  // 根路径不参与「命中就直挂」的判定：否则浏览器带凭据访问 / 也会被截走。
  // 根目录的 WebDAV 流量一定带 Depth 等特征头或来自已知客户端 UA，前面已覆盖。
  if (key === "") return false;
  try {
    if ((await bucket.head(key)) !== null) return true;
    const listing = await bucket.list({ prefix: `${key}/`, limit: 1 });
    return listing.objects.length > 0;
  } catch {
    return false;
  }
}

async function isRootWebDavRequest(
  request: Request,
  pathname: string,
  bucket: R2Bucket,
): Promise<boolean> {
  // 网页端路由优先：/admin/... 的浏览器流量必须留给 SPA，
  // 否则会被重写成 /webdav/admin/...，在 R2 里凭空造出 admin/ 目录。
  if (isWebUiPath(pathname) && isWebUiClientPath(request)) return false;
  if (isReservedPath(pathname)) return false;
  const method = request.method.toUpperCase();
  const userAgent = request.headers.get("user-agent") || "";
  // WebDAV 专有请求头是最强信号（浏览器绝不会带）。
  if (ROOT_DAV_PROBE_HEADERS.some((name) => request.headers.has(name))) return true;
  // 非标准方法：浏览器不会发 PROPFIND / MKCOL / PUT …
  if (WEBDAV_METHODS.has(method)) return true;
  // 已知 WebDAV 客户端 UA 兜底。
  if (WEBDAV_CLIENT_UA.test(userAgent)) return true;
  // 最后一道：GET / HEAD 带凭据时，只有路径真实存在于 R2 才当作直挂，
  // 避免把浏览器的 SPA 导航（/、/admin/…）误判成 DAV 请求。
  if (AMBIGUOUS_METHODS.has(method) && hasDavCredentials(request)) {
    return rootPathExists(bucket, pathname);
  }
  return false;
}

function rootWebDavPath(pathname: string): string {
  return pathname === "/" ? "/webdav/" : `/webdav${pathname}`;
}

async function serveImage(
  bucket: R2Bucket,
  id: string,
  head: boolean
): Promise<Response> {
  const object = await bucket.get(imageObjectKey(id));
  if (object === null) return sitesNotFound();
  const contentType =
    object.customMetadata?.contentType ||
    object.httpMetadata?.contentType ||
    "application/octet-stream";
  const filename = object.customMetadata?.name;
  const headers = imageResponseHeaders({
    contentType,
    filename,
    etag: object.httpEtag,
  });
  return new Response(head ? null : object.body, { status: 200, headers });
}

async function serveSlugSite(
  context: EventContext<MiddlewareEnv, any, any>,
  parsed: { slug: string; key: string; tryIndex: boolean }
): Promise<Response> {
  const method = context.request.method.toUpperCase();
  let key = parsed.key;
  let object = await context.env.BUCKET.get(key);
  if (!object && parsed.tryIndex) {
    key = indexFallbackKey(parsed.key);
    object = await context.env.BUCKET.get(key);
  }
  if (!object) {
    // SPA/404 兜底：仅在最终 miss 时读一次站点配置，正常命中路径零额外 R2 读
    const config = await loadSiteConfig(context.env.BUCKET, parsed.slug);
    if (config?.spa) {
      const spaObject = await context.env.BUCKET.get(siteSpaKey(parsed.slug));
      if (spaObject) {
        return sitesResponse(
          { body: spaObject.body, httpEtag: spaObject.httpEtag },
          siteSpaKey(parsed.slug),
          method === "HEAD"
        );
      }
      return sitesNotFound();
    }
    const notFoundObject = await context.env.BUCKET.get(
      siteNotFoundKey(parsed.slug)
    );
    if (notFoundObject) {
      return sitesNotFoundPage({ body: notFoundObject.body }, method === "HEAD");
    }
    return sitesNotFound();
  }

  return sitesResponse(
    { body: object.body, httpEtag: object.httpEtag },
    key,
    method === "HEAD"
  );
}

export const onRequest: PagesFunction<MiddlewareEnv> = async (context) => {
  const host =
    context.request.headers.get("Host") ||
    new URL(context.request.url).host;
  const url = new URL(context.request.url);

  if (isSitesHost(host, context.env.SITES_HOST)) {
    const method = context.request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const flags = await loadFeatureFlags(context.env.BUCKET);
    const route = resolveSitesHostRoute(url.pathname, flags);
    if (route.kind === "notFound") return sitesNotFound();
    if (route.kind === "image") {
      return serveImage(context.env.BUCKET, route.id, method === "HEAD");
    }
    return serveSlugSite(context, route);
  }

  // Only hit R2 for product routes; static assets and /api/* skip the extra read.
  if (
    url.pathname === "/webdav" ||
    url.pathname.startsWith("/webdav/") ||
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/mcp/")
  ) {
    const flags = await loadFeatureFlags(context.env.BUCKET);
    const blocked = gateDriveProductRoute(url.pathname, flags, context.request);
    if (blocked) return blocked;
  }

  if (await isRootWebDavRequest(context.request, url.pathname, context.env.BUCKET)) {
    const flags = await loadFeatureFlags(context.env.BUCKET);
    const blocked = gateDriveProductRoute(
      "/webdav/",
      flags,
      context.request,
    );
    if (blocked) return blocked;

    const rewrittenUrl = new URL(context.request.url);
    rewrittenUrl.pathname = rootWebDavPath(url.pathname);
    const headers = new Headers(context.request.headers);
    headers.set("X-Davflare-Mount", "root");
    const rewrittenRequest = new Request(rewrittenUrl, {
      method: context.request.method,
      headers,
      body: ["GET", "HEAD"].includes(context.request.method.toUpperCase())
        ? undefined
        : context.request.body,
      // workerd 允许直接喂流式 body，但 vitest 跑在 Node 的 undici 上，
      // 那里对流式 body 强制要求 `duplex: "half"`，否则构造 Request 就抛
      // `RequestInit: duplex option is required when sending a body.`。
      // 该字段不在 workers-types 的 RequestInit 里，且 workerd 会忽略它，
      // 所以用条件展开的方式补上，同时不影响类型检查与生产行为。
      ...({ duplex: "half" } as Record<string, unknown>),
    } as RequestInit);
    // 关键：`context.next(rewrittenRequest)` 在 Pages(miniflare) 下不会按改写后的
    // 路径重新做路由——下游 handler 链是按【原始路径 /】解析出来的（静态资源层），
    // 于是 PROPFIND/PUT 这类非标准方法被静态层直接以 405 拒绝，永远到不了
    // functions/webdav/[[path]].ts。因此这里改为显式直接调用 WebDAV 处理器。
    return davOnRequest({
      ...context,
      request: rewrittenRequest,
    } as typeof context);
  }

  return context.next();
};
