# The cloudflared component for mobile entry

[简体中文](CLOUDFLARED.md) | **English**

See the [User Operations Manual](../docs/OPERATIONS.en.md) for routine use. This page describes the component for deployers. Fixed HTTPS mobile entry does not require cloudflared. Normal startup neither downloads the component nor opens public access; preparation is on demand only when someone explicitly opens temporary mobile entry.

Only `ManagedTunnel.open()` (when a user clicks mobile entry) prepares the component. Starting the backend or checking status does not download it. Status remains STARTING during preparation. Downloading takes at most 120 seconds, after which the existing 50-second connector startup budget begins. The mobile session still lasts at most 5 minutes from connector readiness. The independent worker, dedicated port, authorization, UNKNOWN locking, and isolation of secrets in the environment are unchanged.

## Selection and caching

1. Verify `options.binary` first, then `UPAY_CLOUDFLARED`, by running `--version` with a 5-second timeout. Accept only successful runs whose output contains `cloudflared version`. If an explicitly configured binary cannot run, return `CLOUDFLARED_NOT_FOUND` rather than silently replacing the administrator's configuration.
2. If not explicitly configured, reuse a runnable `cloudflared` found on the system PATH.
3. If missing, download pinned version **2026.3.0** without automatic upgrades. Supported targets are Linux x64/arm64/arm/ia32, macOS x64/arm64, and Windows x64/ia32. Other platforms return an explicit error; the administrator can still configure a runnable binary.
4. Cache at `Store.dir/components/cloudflared/2026.3.0-<official filename>`. The deployment handoff store is an adapter; use its underlying `handoff.database.dir`. Do not install system-wide, change PATH, or require root. Deployment and payment may have separate caches if they use different Store.dir values. Concurrent preparation in the same process and directory is deduplicated. After failure, click again to retry.
5. Downloads are allowed only from the official Cloudflare GitHub release HTTPS path. Redirects may go only to github.com, release-assets.githubusercontent.com, or objects.githubusercontent.com. Credentials, non-443 ports, HTTP, other repositories, and other domains are forbidden. Limits are 4 redirects, 80 MiB downloaded, and 120 seconds total download time. Failure leaves no temporary file.
6. SHA256 hashes are pinned in `cloudflared.cjs`; verify again on every cache reuse. Only verified downloads may be persisted by atomically renaming a randomly named `.tmp` file in the same directory. The official macOS release is only available as a tgz. Limit decompressed size in memory and extract only the regular cloudflared file, not arbitrary paths or symlinks. Retain the verified tgz and verify or repair the cached executable from that trusted archive each time. Never execute unverified downloads.
7. close/shutdown cancels preparation and waits for cleanup; it will not silently fork a process after the download completes. New open calls return busy during preparation or closure. After shutdown, open calls are no longer accepted. A custom `workerPath` in tests/integrations skips preparation by default so fake tests do not trigger downloads. Injection of `ensureCloudflared` is for offline tests only.

## Source, version, and license

- Upstream: https://github.com/cloudflare/cloudflared
- Pinned release: https://github.com/cloudflare/cloudflared/releases/tag/2026.3.0
- Trusted SHA256 source: https://github.com/cloudflare/cloudflared/releases/expanded_assets/2026.3.0, the `sha256:` field in official GitHub release asset metadata. Do not trust a locally computed digest after the download or call the restricted latest API.
- Download: `https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/<official filename>`
- Cloudflare cloudflared uses the Apache License 2.0: https://github.com/cloudflare/cloudflared/blob/2026.3.0/LICENSE. UPayNow does not embed a modified binary; it fetches the upstream component on demand. If a future release bundles the binary, retain upstream LICENSE/NOTICE alongside it.

To upgrade, recheck the official metadata and manually update the version and full digest map. Do not switch the versioned URL to latest or trust a checksum downloaded at runtime.

## UI error codes (all HTTP 502)

| Code | Chinese suggestion | English suggestion |
| --- | --- | --- |
| CLOUDFLARED_NOT_FOUND | 指定的 cloudflared 不存在或无法运行，请检查配置。 | The configured cloudflared is missing or cannot run. Check its configuration. |
| CLOUDFLARED_UNSUPPORTED_PLATFORM | 当前系统/架构不支持自动下载，请手动配置 cloudflared。 | Automatic cloudflared download is unavailable for this platform. Configure it manually. |
| CLOUDFLARED_DOWNLOAD_FAILED | 手机连接组件下载失败，请检查网络后重试。 | Could not download the mobile connection component. Check your network and retry. |
| CLOUDFLARED_INTEGRITY_FAILED | 手机连接组件校验失败，未执行该组件，请重试。 | Mobile connection component integrity check failed. It was not executed. Retry. |
| CLOUDFLARED_CACHE_FAILED | 无法写入手机连接组件缓存，请检查数据目录权限与磁盘空间。 | Cannot write the mobile connection component cache. Check data-directory permissions and free disk space. |
| TUNNEL_CLOSED | 手机连接已关闭，请重新打开。 | The mobile connection was closed. Open it again. |

Offline verification (cloudflared is not required and no public tunnel is opened):

```sh
node --test backend/test/cloudflared.test.cjs backend/test/managed-tunnel.test.cjs backend/test/tunnel-orphan.test.cjs backend/test/deployment-result-ack.test.cjs
```

A successful download in a real environment does not validate the public Cloudflare tunnel. That test requires separate authorization.
