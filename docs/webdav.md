# WebDAV

[English](webdav.md) | [中文](webdav.zh-CN.md)

← [README](../README.md)

**Both endpoints work. The root domain is the simplest one to type.**

Use any WebDAV client (for example [Cx File Explorer](https://play.google.com/store/apps/details?id=com.cxinventor.file.explorer) or [BD File Manager](https://play.google.com/store/apps/details?id=com.liuzho.file.explorer)). Fill in the endpoint plus the username and password you set.

## Choosing an endpoint: both `/` and `/webdav/` work

| Endpoint | Status | Notes |
| --- | --- | --- |
| `https://<domain>/` | ✅ Works | Every method (PROPFIND / MKCOL / LOCK / MOVE / COPY …) works. Browsers still get the web file manager. |
| `https://<domain>/webdav/` | ✅ Works | Explicit mount; identical behaviour. Good for setups that prefer a dedicated path. |

`_middleware.ts` detects WebDAV-looking requests on the root domain and serves
them **directly** from the WebDAV handler with the path rewritten to
`/webdav/...`, while the request URL the handler sees stays the public one, so
`href` values in `207 Multi-Status` responses point back at the root.

Prefer `/webdav/` if you also publish the same domain as a static site for real
visitors — it keeps WebDAV traffic on an unambiguous path.

### How browser traffic is kept separate from DAV traffic

- Opening `https://<domain>/` in a browser shows the web file manager.
- Opening `https://<domain>/admin/`, `/admin/list`, etc. in a browser always
  stays with the SPA and is **never** captured by the root WebDAV mount.
- A request is only treated as WebDAV when it uses a WebDAV method
  (`PROPFIND`, `PROPPATCH`, `MKCOL`, `COPY`, `MOVE`, `LOCK`, `UNLOCK`, …) or
  carries a WebDAV-only header (`Depth`, `Destination`, `Overwrite`,
  `Lock-Token`, `Timeout`) or comes from a known DAV client User-Agent.

## Troubleshooting

### Typing `admin` in the browser dumped a file listing?

Fixed. Web UI routes such as `/admin/...` used to be misread as "a WebDAV
client hitting the root domain" and rewritten to `/webdav/admin/...`. That both
created a phantom `admin/` folder in R2 and handed the UI hrefs with the wrong
prefix. Web UI traffic (either `X-Davflare-UI: 1` or a browser navigation) is
now never captured by the root mount.

### Client reports 405 Method Not Allowed?

Make sure you are on a build that includes the root-mount fix. Symptom of the
old build: `OPTIONS /` and a real client's `PROPFIND /` both return 405 with
`x-frame-options: DENY`. On a fixed build `PROPFIND /` returns **207**.

### Client reports 401 Unauthorized?

Expected until you set `WEBDAV_USERNAME` / `WEBDAV_PASSWORD`. `OPTIONS /` never
requires credentials (clients use it as a capability probe); everything else does.


### Single-file upload fails?

Cloudflare Workers limit a single PUT to **128 MB**. Oversized PUTs return
**HTTP 413** (Chinese message: use the web uploader). Upload large files through
the web UI, which supports chunked uploads.

## In-app panel

The in-app WebDAV panel shows URL, username, and whether public-read is on. It
does **not** display the password.

## Mount with rclone (optional)

1. In rclone: `rclone config` → New remote → type `webdav` → URL `https://<your-domain.com>/webdav/` → vendor `other` → user/pass = your Pages `WEBDAV_USERNAME` / `WEBDAV_PASSWORD`.
2. Leave the WebDAV switch on in `#/settings`.
3. `rclone ls davflare:` (or whatever you named the remote) should list the drive root.

Deploy / env vars: [deploy.md](./deploy.md).
