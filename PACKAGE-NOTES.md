# davflare-cf-webdav333（完整源码）

Cloudflare Pages + R2 的 WebDAV 网盘。本包已包含两项修复/增强：

1. **根域名直挂 WebDAV** —— 客户端不加 `/webdav` 前缀也能用根域名访问
2. **MCP 自描述能力** —— 连上 MCP 的 AI 不需要先读文档就能正确操作

---

## 一、快速开始

```bash
npm install
npx tsc --noEmit      # 类型检查
npm run build         # 构建 SPA

# 本地跑（会读 .dev.vars，本包未包含，需自己建）
cp .dev.vars.example .dev.vars   # 或手动创建，见下
npx wrangler pages dev build
```

### 用户名 / 密码

在 `wrangler.toml` 的 `[vars]` 里改成自己的值：

```
WEBDAV_USERNAME = "your-username"
WEBDAV_PASSWORD = "your-password"
```

本地开发也可复制 `.dev.vars.example` 为 `.dev.vars`（已 gitignore），会覆盖 toml 里的同名变量。Pages 控制台环境变量同样可以覆盖。

### 部署

推到 GitHub 后在 Cloudflare Pages 连接该仓库；或在 CI 里 `npm run build` 后 `wrangler pages deploy build`。

R2 绑定名必须是 `BUCKET`（见 `wrangler.toml`）。`SITES_HOST` 在 CF Pages 后台设为环境变量，不要写进 `wrangler.toml`。

---

## 二、修复一：根域名直挂 WebDAV

### 问题

WebDAV 客户端把根域名当挂载点（`https://drive.example.com/`）时返回 **405**，必须用 `/webdav/` 才行。

### 真实根因

不在 WebDAV 协议实现里，而在 Cloudflare Pages 的**路由语义**：

> `context.next(rewrittenRequest)` 在 Pages(miniflare) 下**不会按改写后的 URL 重新路由**。下游 handler 链是按**原始入站路径**解析出来的（静态资源层）。

所以「改写路径再 `next()`」这个写法在 Pages 上根本不成立 —— 请求会被静态资源层接走，回落到 SPA 的 `index.html`，表现为 405 或返回 HTML。

### 修复

不再 `context.next()`，改为**直接调用 DAV 处理器**（`functions/_middleware.ts`）：

```ts
return davOnRequest({
  ...context,
  request: rewrittenRequest,
} as typeof context);
```

另有一段必要修正：Node 的 undici 对流式 body 强制要求 `duplex: "half"`，而 workers-types 的 `RequestInit` 没这个字段、workerd 又会忽略它：

```ts
...({ duplex: "half" } as Record<string, unknown>),
} as RequestInit);
```

### 附带发现的第二个缺陷：GET 被静默劫持

真实客户端库测试时发现 `getFileContents` 返回的是 **SPA 的 HTML** 而非文件内容。

原因：`GET`/`HEAD` 是标准 HTTP 方法，**无法靠方法区分浏览器和客户端**。

修复思路 —— 「带凭据 + 路径在 R2 中真实存在」双重裁决：

```ts
const AMBIGUOUS_METHODS = new Set(["GET", "HEAD"]);

if (AMBIGUOUS_METHODS.has(method) && hasDavCredentials(request)) {
  return rootPathExists(bucket, pathname);   // 命中才当直挂
}
```

根路径（`key === ""`）**不参与**这个判定 —— 否则浏览器带凭据访问 `/` 也会被截走。

### 判定顺序

1. Web UI 路径 + Web UI 客户端头 → 不是
2. 保留路径（`/webdav`、`/api`、`/mcp`、`/share`、`/health`、静态资源）→ 不是
3. DAV 探针头（`depth`/`destination`/`overwrite`/`lock-token`/`timeout`）→ 是
4. DAV 方法（PROPFIND/MKCOL/COPY/MOVE/LOCK/...）→ 是
5. DAV 客户端 UA（rclone/Cyberduck/WinSCP/Windows 资源管理器...）→ 是
6. GET/HEAD + 有凭据 + 路径真实存在 → 是

---

## 三、增强二：MCP 自描述

### 背景

原本 MCP 客户端连上后只拿到 25 条英文 `description`，不知道正确工作流、参数语义、容量边界和开关依赖。AI 只能靠试错。

### 三层改动（`functions/_mcp.ts`）

**1. `initialize` 返回 `instructions`（中文，1390 字符）**

客户端会自动注入模型上下文。涵盖：路径即 R2 object key 的心智模型、「先 `list` 再动手」的默认流程、**`path` 是目标目录 / `name` 才是文件名**、1 MiB 与 25 MB 的容量边界、`delete` 默认进回收站可捞回、功能开关关闭致 404、`push` 禁明文密钥、三类典型任务。

**2. 25 个工具全部补 `title` + `annotations`**

```
list      列出目录        {"readOnlyHint":true}
upload    上传文件        {"destructiveHint":true}
download  下载文件        {"readOnlyHint":true,"idempotentHint":true}
delete    删除文件或目录   {"destructiveHint":true}
...
```

客户端可据此给危险操作加确认。

**3. 参数错误自解释**

```
Invalid arguments for upload: `name` (file name) is required.
Note `path` is the TARGET FOLDER; the file name goes in `name`.

Correct shape: {"name":"upload","arguments":{"path":"docs","name":"a.txt","content":"hello"}}
```

### 网页侧

`#/mcp` 试玩台新增「拉取实际说明」按钮，可直接看到服务端下发的 `instructions` 原文并复制。

### 验证自描述生效

```bash
curl -s https://<你的域名>/mcp \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | python3 -m json.tool | head -40
```

响应中应出现 `instructions` 字段。

---

## 四、验证情况

| 验证项 | 结果 |
|---|---|
| 端到端 WebDAV 测试 | ✅ 27/27 |
| 真实客户端库 `webdav@5` | ✅ 11/11 |
| 官方 MCP SDK 端到端 | ✅ 15/15 |
| `mcp.test.ts` | ✅ 37/37 |
| `tsc --noEmit` | ✅ 干净 |
| 干净重建 install→tsc→build | ✅ |
| 回归测试有效性 | ✅ 删掉 `instructions` 后立即失败 |

### 已知既有问题（与本包改动无关）

`src/app/__tests__/extension.test.ts` 与 `src/extensionDrive/__tests__/main.test.tsx` 在资源紧张时会超时。**已用未打补丁的原始版本对照验证：失败项完全相同**，单独跑 17/17 全绿。

---

## 五、目录

```
functions/          Cloudflare Pages Functions
  _middleware.ts      路由中间件（根域名直挂修复在此）
  _mcp.ts             MCP 协议实现（自描述增强在此）
  mcp.ts              MCP HTTP 端点
  _davroute.ts        Web UI 路由常量
  api/                开放 API
  webdav/             WebDAV 协议实现
src/                React 前端
  McpPlaygroundView.tsx  MCP 试玩台
  WebDavPanel.tsx        WebDAV 设置面板
docs/               文档
  API.zh-CN.md          API + MCP（含「自描述」章节）
  webdav.zh-CN.md       WebDAV 使用说明
extension/          浏览器扩展
agents/examples/    agent 示例
```

---

## 六、未包含的文件

| 文件 | 原因 |
|---|---|
| `node_modules/` | 依赖，`npm install` 生成 |
| `build/` | 构建产物，`npm run build` 生成 |
| `extension/drive/` | 扩展构建产物，见 `.gitignore` |
| `.wrangler/` | 本地缓存 |
| `.dev.vars` | **含本地凭据**，需自己创建（见第一节） |
