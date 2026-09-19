import { vi } from "vitest";
/**
 * functions/_middleware.ts + functions/_sites.ts 分支级直测：
 * SITES_HOST 接管（静态命中 / index 回退 / spa / 404.html / 纯 404）、
 * 路径穿越与内部前缀保护、图片宿主 /i/{id}、产品路由开关门禁。
 */
import { onRequest } from "../../../functions/_middleware";
import {
  isValidSlug,
  mimeForKey,
  parseSitesPath,
  siteConfigKey,
} from "../../../functions/_sites";
import {
  InMemoryBucket,
  basicAuthHeader,
  makeContext,
} from "../testInMemoryBucket";

const HOST = "http://sites.example.com";
const IMAGE_ID = "0123456789abcdef0123456789abcdef";

interface MiddlewareEnv {
  BUCKET: R2Bucket;
  SITES_HOST?: string;
  // 根挂载现在直接调用 WebDAV 处理器，测试 env 必须与 _middleware 的
  // MiddlewareEnv 保持一致（否则 TS2345：同名类型不兼容）。
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
  WEBDAV_PUBLIC_READ?: string;
}

function makeEnv(bucket: InMemoryBucket, extra: Record<string, unknown> = {}): MiddlewareEnv {
  // 默认补上 WebDAV 凭据：根挂载直连 DAV 处理器，缺凭据会 fail-closed 403。
  return {
    BUCKET: bucket.asBucket(),
    WEBDAV_USERNAME: "user",
    WEBDAV_PASSWORD: "pass",
    ...extra,
  };
}

function siteRequest(
  path: string,
  env: MiddlewareEnv,
  options: { method?: string; host?: string; headers?: Record<string, string>; next?: (request?: Request) => Promise<Response> } = {}
) {
  const request = new Request(`${HOST}${path}`, {
    method: options.method ?? "GET",
    headers: { Host: options.host ?? "sites.example.com", ...(options.headers ?? {}) },
  });
  return onRequest(makeContext(request, env, {}, options.next));
}

// ————————————————————————————————————————————————————————————————
// 修复验证：网页端路由（/admin...）绝不能被当成根域名 WebDAV 客户端流量。
// 回归前：PROPFIND /admin/ 被重写成 /webdav/admin/，在 R2 里凭空造出
// admin/ 目录，且前端 href 前缀与 davHrefToKey 的期望不符。
// ————————————————————————————————————————————————————————————————
describe("web UI routes are never captured by the root WebDAV mount", () => {
  test("PROPFIND /admin/ (session client) passes through to next untouched", async () => {
    const bucket = new InMemoryBucket();
    let forwarded: Request | undefined;
    const next = vi.fn(async (request?: Request) => {
      forwarded = request;
      return new Response("dav", { status: 207 });
    });
    const response = await siteRequest("/admin/", makeEnv(bucket), {
      method: "PROPFIND",
      host: "drive.example.com",
      headers: { "X-Davflare-UI": "1", Authorization: "Bearer tok", Depth: "1" },
      next,
    });
    expect(response.status).toBe(207);
    expect(next).toHaveBeenCalledTimes(1);
    // 关键：没有被重写成 /webdav/admin/
    expect(forwarded).toBeUndefined();
  });

  test("browser navigation to /admin/ and /admin/list is not rewritten", async () => {
    const bucket = new InMemoryBucket();
    for (const path of ["/admin/", "/admin/list"]) {
      const next = vi.fn(async (request?: Request) => {
        expect(request).toBeUndefined();
        return new Response("spa", { status: 200 });
      });
      const response = await siteRequest(path, makeEnv(bucket), {
        host: "drive.example.com",
        headers: { "user-agent": "Mozilla/5.0 Chrome/140", "Sec-Fetch-Mode": "navigate" },
        next,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("spa");
    }
  });

  test("browser navigation to /admin/ with embedded credentials is not rewritten", async () => {
    const bucket = new InMemoryBucket();
    const next = vi.fn(async (request?: Request) => {
      expect(request).toBeUndefined();
      return new Response("spa", { status: 200 });
    });
    // 用户在地址栏输入 https://admin:admin@host/admin/ 时浏览器会带 Basic 头；
    // 靠 Sec-Fetch-Mode: navigate 识别为网页端导航，而不是 WebDAV 客户端。
    await siteRequest("/admin/", makeEnv(bucket), {
      host: "drive.example.com",
      headers: {
        "user-agent": "Mozilla/5.0 Chrome/140",
        Authorization: `Basic ${btoa("admin:admin")}`,
        "Sec-Fetch-Mode": "navigate",
      },
      next,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("non-document GET /admin/ without Sec-Fetch-Mode is not rewritten", async () => {
    // 兜底：即便 Sec-Fetch-Mode 缺失（反向代理剥离/老浏览器），
    // 浏览器 UA 也绝不会被根域名 WebDAV 接管，页面照常渲染。
    const bucket = new InMemoryBucket();
    const next = vi.fn(async (request?: Request) => {
      expect(request).toBeUndefined();
      return new Response("spa", { status: 200 });
    });
    const response = await siteRequest("/admin/", makeEnv(bucket), {
      host: "drive.example.com",
      headers: { "user-agent": "Mozilla/5.0 Chrome/140" },
      next,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("spa");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("real WebDAV client PROPFIND on /admin/ still reaches the mount", async () => {
    // rclone 访问 https://host/admin/ 应仍走 WebDAV（网盘里真有个叫 admin 的目录）。
    // 现在中间件直接调用 DAV 处理器，因此断言真实 DAV 响应。
    const bucket = new InMemoryBucket();
    const next = vi.fn(async () => new Response("static-layer", { status: 200 }));
    const response = await siteRequest("/admin/", defaultEnv(bucket), {
      method: "PROPFIND",
      host: "drive.example.com",
      headers: {
        "user-agent": "rclone/v1.65",
        Authorization: basicAuthHeader(),
        Depth: "1",
      },
      next,
    });
    // 该目录不存在 → 404（而不是落到静态层的 405/200）
    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});

function defaultEnv(bucket: InMemoryBucket) {
  // 根挂载现在直接调用真实 DAV 处理器，必须补上凭据：
  // handleRequest 在 WEBDAV_USERNAME/PASSWORD 缺失时 fail-closed 返回 403。
  return makeEnv(bucket, {
    SITES_HOST: "sites.example.com",
    WEBDAV_USERNAME: "user",
    WEBDAV_PASSWORD: "pass",
  });
}

describe("sites path parsing (parseSitesPath / helpers)", () => {
  test("valid slugs and keys", () => {
    expect(parseSitesPath("/blog/index.html")).toEqual({
      ok: true,
      slug: "blog",
      key: "sites/blog/index.html",
      tryIndex: false,
    });
    expect(parseSitesPath("/blog")).toEqual({
      ok: true,
      slug: "blog",
      key: "sites/blog/index.html",
      tryIndex: false,
    });
    expect(parseSitesPath("/Blog/style.CSS")).toEqual({
      ok: true,
      slug: "blog",
      key: "sites/blog/style.CSS",
      tryIndex: false,
    });
    expect(parseSitesPath("/blog/sub/page")).toEqual({
      ok: true,
      slug: "blog",
      key: "sites/blog/sub/page",
      tryIndex: true,
    });
  });

  test("rejects traversal, encoded traversal, internal prefixes and bad slugs", () => {
    expect(parseSitesPath("/blog/../secret").ok).toBe(false);
    expect(parseSitesPath("/blog/%2e%2e/secret").ok).toBe(false);
    expect(parseSitesPath("/blog/%2e%2e%2fsecret").ok).toBe(false);
    expect(parseSitesPath("/blog/_$flaredrive$/apikeys/x").ok).toBe(false);
    expect(parseSitesPath("/_$flaredrive$/config.json").ok).toBe(false);
    expect(parseSitesPath("/").ok).toBe(false);
    expect(parseSitesPath("/Bad_Slug/x").ok).toBe(false);
    // 文件名内部的合法 "a..b" 不受影响
    expect(parseSitesPath("/blog/a..b.html").ok).toBe(true);
  });

  test("slug regex and mime table", () => {
    expect(isValidSlug("blog")).toBe(true);
    expect(isValidSlug("-blog")).toBe(false);
    expect(isValidSlug("Blog")).toBe(false);
    expect(mimeForKey("sites/x/index.html")).toBe("text/html; charset=utf-8");
    expect(mimeForKey("sites/x/app.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeForKey("sites/x/data.weird")).toBe("application/octet-stream");
    expect(siteConfigKey("blog")).toBe("_$flaredrive$/sites/blog.json");
  });
});

describe("sites host: static serving", () => {
  function seedSite(bucket: InMemoryBucket, slug = "blog") {
    bucket.seed([
      { key: `sites/${slug}/index.html`, body: "<h1>home</h1>", contentType: "text/html" },
      { key: `sites/${slug}/app.js`, body: "console.log(1)", contentType: "text/javascript" },
      { key: `sites/${slug}/data.bin`, body: "\x00\x01", contentType: "application/octet-stream" },
    ]);
  }

  test("exact object hit returns 200 with mime/nosniff/cache headers", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/app.js", defaultEnv(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(response.headers.get("ETag")).toMatch(/^"/);
    expect(await response.text()).toBe("console.log(1)");
  });

  test("extensionless directory path falls back to its own index.html", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    bucket.seed([
      { key: "sites/blog/about/index.html", body: "<h1>about</h1>", contentType: "text/html" },
    ]);
    const response = await siteRequest("/blog/about", defaultEnv(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<h1>about</h1>");
  });

  test("root path serves index.html directly", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/", defaultEnv(bucket));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home</h1>");
  });

  test("unknown extension falls back to octet-stream", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/data.bin", defaultEnv(bucket));
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("HEAD returns headers without body", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/app.js", defaultEnv(bucket), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("plain miss without spa/404 page is a bare 404", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/missing.png", defaultEnv(bucket));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Not Found");
  });

  test("spa=true falls back to the site index.html on miss", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    bucket.seed([
      {
        key: siteConfigKey("blog"),
        body: JSON.stringify({ slug: "blog", spa: true }),
        contentType: "application/json",
      },
    ]);
    const response = await siteRequest("/blog/missing.png", defaultEnv(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<h1>home</h1>");
  });

  test("custom 404.html is served with 404 status and no-store", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    bucket.seed([
      { key: "sites/blog/404.html", body: "<h1>custom 404</h1>", contentType: "text/html" },
    ]);
    const response = await siteRequest("/blog/missing.png", defaultEnv(bucket));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("<h1>custom 404</h1>");
  });

  test("non-GET/HEAD methods on the sites host are 405", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    const response = await siteRequest("/blog/app.js", defaultEnv(bucket), { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  test("malformed paths (traversal / internal prefix / root) are plain 404", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    for (const path of [
      "/blog/%2e%2e/secret",
      "/blog/%2e%2e%2fsecret",
      "/blog/_$flaredrive$/apikeys/x.json",
      "/_$flaredrive$/config.json",
      "/",
      "/Bad_Slug/x",
    ]) {
      const response = await siteRequest(path, defaultEnv(bucket));
      expect(response.status).toBe(404);
    }
  });

  test("sites flag off 404s slug routes but keeps images host working", async () => {
    const bucket = new InMemoryBucket();
    seedSite(bucket);
    bucket.seed([
      {
        key: "_$flaredrive$/config.json",
        body: JSON.stringify({ sites: false }),
        contentType: "application/json",
      },
      {
        key: "_$flaredrive$/img/" + IMAGE_ID,
        body: "png",
        customMetadata: { contentType: "image/png" },
      },
    ]);
    const env = makeEnv(bucket, { SITES_HOST: "sites.example.com" });
    const slug = await siteRequest("/blog/app.js", env);
    expect(slug.status).toBe(404);
    const image = await siteRequest(`/i/${IMAGE_ID}`, env);
    expect(image.status).toBe(200);
  });
});

describe("sites host: image routes (/i/{id})", () => {
  function seedImage(bucket: InMemoryBucket, contentType = "image/png", name?: string) {
    bucket.seed([
      {
        key: "_$flaredrive$/img/" + IMAGE_ID,
        body: "image-bytes",
        customMetadata: {
          contentType,
          ...(name ? { name } : {}),
        },
      },
    ]);
  }

  test("serves the image with inline disposition and long cache", async () => {
    const bucket = new InMemoryBucket();
    seedImage(bucket, "image/png", "shot.png");
    const response = await siteRequest(`/i/${IMAGE_ID}`, defaultEnv(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("image-bytes");
  });

  test("svg content is forced to attachment", async () => {
    const bucket = new InMemoryBucket();
    seedImage(bucket, "image/svg+xml", "logo.svg");
    const response = await siteRequest(`/i/${IMAGE_ID}`, defaultEnv(bucket));
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  test("missing image is 404; bad id is 404", async () => {
    const bucket = new InMemoryBucket();
    expect((await siteRequest(`/i/${IMAGE_ID}`, defaultEnv(bucket))).status).toBe(404);
    expect((await siteRequest("/i/nothex", defaultEnv(bucket))).status).toBe(404);
  });

  test("imageHost flag off 404s image routes even when sites is on", async () => {
    const bucket = new InMemoryBucket();
    seedImage(bucket);
    bucket.seed([
      {
        key: "_$flaredrive$/config.json",
        body: JSON.stringify({ imageHost: false }),
        contentType: "application/json",
      },
    ]);
    const response = await siteRequest(`/i/${IMAGE_ID}`, defaultEnv(bucket));
    expect(response.status).toBe(404);
  });
});

describe("sites host host-matching", () => {
  test("non-matching Host falls through to product routing (next)", async () => {
    const bucket = new InMemoryBucket();
    const next = vi.fn(async () => new Response("next-ok", { status: 200 }));
    const response = await siteRequest("/blog/app.js", defaultEnv(bucket), {
      host: "drive.example.com",
      next,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("next-ok");
  });

  test("SITES_HOST comparison ignores case, port and trailing dot", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([
      { key: "sites/blog/index.html", body: "hi", contentType: "text/html" },
    ]);
    const env = makeEnv(bucket, { SITES_HOST: "Sites.Example.com." });
    const response = await siteRequest("/blog/", env, { host: "sites.example.com:8443" });
    expect(response.status).toBe(200);
  });

  test("missing SITES_HOST config never takes over", async () => {
    const bucket = new InMemoryBucket();
    const next = vi.fn(async () => new Response("next-ok", { status: 200 }));
    const response = await siteRequest("/blog/", makeEnv(bucket), { next });
    expect(next).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("next-ok");
  });
});

describe("drive product route gates (webdav/mcp)", () => {
  test("browser GET / passes through unchanged", async () => {
    const bucket = new InMemoryBucket();
    let forwarded: Request | undefined;
    const next = vi.fn(async (request?: Request) => {
      forwarded = request;
      return new Response("spa", { status: 200 });
    });
    const response = await siteRequest("/", makeEnv(bucket), {
      host: "drive.example.com",
      headers: { "user-agent": "Mozilla/5.0 Chrome/140" },
      next,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("spa");
    expect(next).toHaveBeenCalledTimes(1);
    expect(forwarded).toBeUndefined();
  });

  test("root WebDAV requests are served by the DAV handler directly", async () => {
    // 修复回归：根域名直挂此前用 `context.next(改写后的请求)` 转发，但 Pages
    // 不按改写后的路径重新路由——下游按【原始路径 /】落在静态资源层，非标准
    // 方法被静态层以 405 短路，`PROPFIND /` 永远到不了 WebDAV 处理器。
    // 现在中间件直接调用 DAV 处理器，因此这里断言真实 DAV 响应，而不是转发。
    const bucket = new InMemoryBucket();
    const next = vi.fn(async () => new Response("static-layer", { status: 200 }));
    const response = await siteRequest("/", defaultEnv(bucket), {
      method: "PROPFIND",
      host: "drive.example.com",
      headers: {
        "user-agent": "Microsoft-WebDAV-MiniRedir/10.0",
        Authorization: basicAuthHeader(),
        Depth: "1",
      },
      next,
    });
    // 关键：不再落回静态层（旧实现此处会是 405），而是真的返回 DAV 响应。
    expect(response.status).toBe(207);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(await response.text()).toContain("<multistatus");
    expect(next).not.toHaveBeenCalled();
  });

  test("root WebDAV requests without credentials get 401 + WWW-Authenticate", async () => {
    const bucket = new InMemoryBucket();
    const response = await siteRequest("/", defaultEnv(bucket), {
      method: "PROPFIND",
      host: "drive.example.com",
      headers: { "user-agent": "rclone/v1.65", Depth: "1" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="WebDAV"');
  });

  test("root OPTIONS needs no credentials and advertises the DAV class", async () => {
    // 客户端在收发凭据前先探 DAV/Allow，回 401 会被判定「不是 WebDAV 端点」。
    const bucket = new InMemoryBucket();
    const response = await siteRequest("/", defaultEnv(bucket), {
      method: "OPTIONS",
      host: "drive.example.com",
      headers: { "user-agent": "rclone/v1.65" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("DAV")).toBe("1, 2");
    expect(response.headers.get("Allow")).toContain("PROPFIND");
  });

  test("webdav disabled returns 404 unless the UI client header is present", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([
      {
        key: "_$flaredrive$/config.json",
        body: JSON.stringify({ webdav: false }),
        contentType: "application/json",
      },
    ]);
    const blocked = await siteRequest("/webdav/", makeEnv(bucket), {
      host: "drive.example.com",
    });
    expect(blocked.status).toBe(404);
    expect(blocked.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const next = vi.fn(async () => new Response("next-ok", { status: 200 }));
    const allowed = await siteRequest("/webdav/", makeEnv(bucket), {
      host: "drive.example.com",
      headers: { "X-Davflare-UI": "1" },
      next,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(allowed.status).toBe(200);
  });

  test("mcp requires both mcp and apiKey flags", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([
      {
        key: "_$flaredrive$/config.json",
        body: JSON.stringify({ mcp: false, apiKey: true }),
        contentType: "application/json",
      },
    ]);
    const blocked = await siteRequest("/mcp", makeEnv(bucket), {
      host: "drive.example.com",
    });
    expect(blocked.status).toBe(404);

    const bucket2 = new InMemoryBucket();
    bucket2.seed([
      {
        key: "_$flaredrive$/config.json",
        body: JSON.stringify({ mcp: true, apiKey: false }),
        contentType: "application/json",
      },
    ]);
    const blocked2 = await siteRequest("/mcp", makeEnv(bucket2), {
      host: "drive.example.com",
    });
    expect(blocked2.status).toBe(404);
  });

  test("enabled product routes and /api/* paths pass through to next", async () => {
    const bucket = new InMemoryBucket();
    const next = vi.fn(async () => new Response("next-ok", { status: 200 }));
    for (const path of ["/webdav/", "/mcp", "/api/upload", "/share/tok"]) {
      next.mockClear();
      const response = await siteRequest(path, makeEnv(bucket), {
        host: "drive.example.com",
        next,
      });
      expect(next).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("next-ok");
    }
  });
});

// ————————————————————————————————————————————————————————————————
// 根域名直挂：带 body 的方法必须原样送达 DAV 处理器。
// 修复把 `context.next(改写后请求)` 换成直接调用 DAV handler，
// 并手工构造 `new Request(url, { body: context.request.body })`。
// Request 的 body 流只能消费一次，因此这里守住「body 不被吞掉」。
// ————————————————————————————————————————————————————————————————
describe("root mount forwards request bodies intact", () => {
  test("PROPPATCH via the root mount reaches the DAV handler with its body", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([{ key: "pp.txt", body: "x" }]);
    const xml =
      '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:">' +
      '<D:set><D:prop><Z:Authors xmlns:Z="http://ns.example.com/z39.50/">' +
      "<Z:Author>Jim</Z:Author></Z:Authors></D:prop></D:set></D:propertyupdate>";
    const request = new Request(`${HOST}/pp.txt`, {
      method: "PROPPATCH",
      headers: {
        Host: "drive.example.com",
        "user-agent": "rclone/v1.65",
        Authorization: basicAuthHeader(),
        "Content-Type": "application/xml",
      },
      body: xml,
    });
    const next = vi.fn(async () => new Response("static-layer", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    // 207 = 真的进了 DAV 处理器并完成了 PROPPATCH
    expect(response.status).toBe(207);
    expect(next).not.toHaveBeenCalled();
  });

  test("PUT via the root mount stores the exact bytes", async () => {
    const bucket = new InMemoryBucket();
    const request = new Request(`${HOST}/up.txt`, {
      method: "PUT",
      headers: {
        Host: "drive.example.com",
        "user-agent": "rclone/v1.65",
        Authorization: basicAuthHeader(),
        "Content-Type": "text/plain",
      },
      body: "root-mount-body",
    });
    const next = vi.fn(async () => new Response("static-layer", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    expect(response.status).toBe(201);
    expect(bucket.rawText("up.txt")).toBe("root-mount-body");
    expect(next).not.toHaveBeenCalled();
  });
});

// ————————————————————————————————————————————————————————————————
// 修复回归：GET / HEAD 是标准 HTTP 方法，无法仅凭请求特征区分浏览器与
// WebDAV 客户端。不少客户端（自研库、Go/axios 等）下载时只带 Authorization，
// 没有 rclone/WebDAVFS 之类的 UA，也没有 Depth 头；旧实现会把它们放给静态
// 资源层，于是回退到 SPA 的 index.html —— 客户端拿到的"文件内容"其实是 HTML。
// 现在改为「凭据 + 路径在 R2 中真实存在」共同裁决。
// ————————————————————————————————————————————————————————————————
describe("root mount: credential-only GET downloads the object, not the SPA fallback", () => {
  test("GET with credentials on an existing object reaches the DAV handler", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([{ key: "dl.txt", body: "real-file-bytes" }]);
    // 关键：UA 既不是浏览器也不是已知 DAV 客户端，且不带 Depth 等特征头。
    const request = new Request(`${HOST}/dl.txt`, {
      method: "GET",
      headers: {
        Host: "drive.example.com",
        "user-agent": "axios/1.6.0",
        Authorization: basicAuthHeader(),
      },
    });
    const next = vi.fn(async () => new Response("spa-index-html", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    // 旧实现：next 被调用、响应体是 SPA HTML。新实现：真的返回对象内容。
    expect(await response.text()).toBe("real-file-bytes");
    expect(next).not.toHaveBeenCalled();
  });

  test("GET with credentials on a missing path still falls back to the static layer", async () => {
    const bucket = new InMemoryBucket();
    const request = new Request(`${HOST}/does-not-exist.txt`, {
      method: "GET",
      headers: {
        Host: "drive.example.com",
        "user-agent": "axios/1.6.0",
        Authorization: basicAuthHeader(),
      },
    });
    const next = vi.fn(async () => new Response("spa-index-html", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    // 未命中对象 → 交给静态资源层（SPA 路由回退），不能被 DAV 截走。
    expect(await response.text()).toBe("spa-index-html");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("browser navigation to / with credentials still returns the SPA", async () => {
    const bucket = new InMemoryBucket();
    const request = new Request(`${HOST}/`, {
      method: "GET",
      headers: {
        Host: "drive.example.com",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0",
        Authorization: basicAuthHeader(),
      },
    });
    const next = vi.fn(async () => new Response("spa-index-html", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    // 根路径不参与「命中即直挂」判定，避免带凭据的浏览器访问被截走。
    expect(await response.text()).toBe("spa-index-html");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("GET without credentials never reaches the DAV handler", async () => {
    const bucket = new InMemoryBucket();
    bucket.seed([{ key: "pub.txt", body: "secret" }]);
    const request = new Request(`${HOST}/pub.txt`, {
      method: "GET",
      headers: {
        Host: "drive.example.com",
        "user-agent": "axios/1.6.0",
      },
    });
    const next = vi.fn(async () => new Response("spa-index-html", { status: 200 }));
    const response = await onRequest(
      makeContext(request, defaultEnv(bucket), {}, next) as never,
    );
    expect(await response.text()).toBe("spa-index-html");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
