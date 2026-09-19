# WebDAV

[English](webdav.md) | [中文](webdav.zh-CN.md)

← [README](../README.zh-CN.md)

**两个端点都能用，根域名最省事。**

可用任意 WebDAV 客户端（例如 [Cx File Explorer](https://play.google.com/store/apps/details?id=com.cxinventor.file.explorer) 或 [BD File Manager](https://play.google.com/store/apps/details?id=com.liuzho.file.explorer)）。填入地址以及你设置的用户名和密码。

## 端点选择：`/` 和 `/webdav/` 都可以

| 端点 | 状态 | 说明 |
| --- | --- | --- |
| `https://<domain>/` | ✅ 可用 | 所有方法（PROPFIND / MKCOL / LOCK / MOVE / COPY …）均可用；浏览器访问仍然是网页端文件管理器 |
| `https://<domain>/webdav/` | ✅ 可用 | 显式挂载点，行为完全一致；适合偏好专用路径的场景 |

`_middleware.ts` 会识别根域名上的 WebDAV 请求，**直接调用** WebDAV 处理器，
内部路径重写为 `/webdav/...`；处理器看到的仍是公开 URL，因此 `207
Multi-Status` 响应里的 `href` 指回根域名，客户端能正确解析。

如果你把同一域名同时当作真实访客的静态站使用，建议用 `/webdav/`，让 WebDAV
流量走一条无歧义的路径。

### 浏览器流量与 DAV 流量如何区分

- 用浏览器打开 `https://<domain>/` —— 正常显示网页端文件管理器。
- 用浏览器打开 `https://<domain>/admin/`、`/admin/list` 等网页端路由 ——
  始终交给 SPA，**不会**被 WebDAV 直挂截走。
- 只有满足以下条件之一的请求才判定为 WebDAV：使用 WebDAV 方法
  （`PROPFIND`、`PROPPATCH`、`MKCOL`、`COPY`、`MOVE`、`LOCK`、`UNLOCK` …），
  或带 WebDAV 专有请求头（`Depth`、`Destination`、`Overwrite`、
  `Lock-Token`、`Timeout`），或来自已知 DAV 客户端 User-Agent。

## 常见问题

### 浏览器输入 `admin` 后页面变成一串文件列表？

已修复。此前 `/admin/...` 这类网页端路由会被误判为「WebDAV 客户端访问
根域名」，被重写成 `/webdav/admin/...`：既在 R2 里凭空造出一个 `admin/`
目录，又让网页端拿到前缀不对的 href。现在网页端流量（带
`X-Davflare-UI: 1`，或浏览器导航）一律不被根域名直挂接管。

### 客户端报 405 Method Not Allowed？

先确认你部署的是包含根域名直挂修复的版本。旧版症状：`OPTIONS /` 和真实
客户端的 `PROPFIND /` 都返回 405，且带 `x-frame-options: DENY`。修复后
`PROPFIND /` 返回 **207**。

### 客户端报 401 Unauthorized？

未配置 `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` 时属于预期行为。`OPTIONS /`
永远不需要凭据（客户端用它做能力探测），其余方法都需要。

### 单文件上传失败？

Cloudflare Workers 单次 PUT 上限为 **128 MB**。超限会返回 **HTTP 413**
（提示使用网页上传）。大文件请走网页端分片上传。

## 应用内面板

应用内 WebDAV 面板会显示 URL、用户名，以及是否开启公开读取。**不会**显示密码。

## 用 rclone 挂载（可选）

1. `rclone config` → New remote → 类型 `webdav` → URL `https://<your-domain.com>/webdav/` → vendor `other` → 用户名/密码 = Pages 里的 `WEBDAV_USERNAME` / `WEBDAV_PASSWORD`。
2. `#/settings` 里保持 WebDAV 开关打开。
3. `rclone ls davflare:`（远程名随你）应能列出网盘根目录。

部署与环境变量见 [deploy.zh-CN.md](./deploy.zh-CN.md)。
