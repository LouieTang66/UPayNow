# 手机入口的 cloudflared 组件

日常操作见 [用户操作手册](../docs/OPERATIONS.md)。本页是部署者的组件技术说明；固定 HTTPS 手机入口不需要 cloudflared。普通启动不会因此下载组件或开放公网，只有明确打开临时手机入口才按需准备。

仅 `ManagedTunnel.open()`（用户点击手机入口）准备组件，启动后台、查询状态不会下载。准备阶段维持 STARTING；下载最多 120 秒，完成后才开始原有 50 秒 connector 启动预算。手机会话仍从 connector ready 起最长 5 分钟，独立 worker/专用端口/授权/UNKNOWN 锁与 secret 环境隔离不变。

## 选择与缓存

1. 优先验证 `options.binary`，其次 `UPAY_CLOUDFLARED`，执行 `--version`（5 秒超时），只接受成功且输出含 `cloudflared version`。显式配置不可运行时返回 `CLOUDFLARED_NOT_FOUND`，不偷偷替换管理员配置。
2. 未显式配置时复用系统 PATH 中可运行的 `cloudflared`。
3. 缺失时下载固定版本 **2026.3.0**，不会自动升级。支持 Linux x64/arm64/arm/ia32、macOS x64/arm64、Windows x64/ia32；其他平台明确报错（仍可自行配置可运行程序）。
4. 缓存位置：`Store.dir/components/cloudflared/2026.3.0-<官方文件名>`（部署 handoff 的 store 是适配器，使用其底层 `handoff.database.dir`）。不安装到系统、不改 PATH、不用 root；部署与收款 Store.dir 不同时可分别缓存。同进程同目录组件准备并发去重，失败后可再次点击重试。
5. 下载只允许 GitHub Cloudflare 官方 release HTTPS 路径，跳转仅接受 github.com、release-assets.githubusercontent.com、objects.githubusercontent.com；禁止账号密码、非 443 端口、HTTP、其他仓库与域名。最多 4 次跳转、80 MiB 下载体积、120 秒总下载时间。失败不留临时文件。
6. SHA256 固定在 `cloudflared.cjs`，每次缓存复用重新校验。下载校验成功才允许同目录随机 `.tmp` 文件原子 rename 落盘。macOS 官方仅提供 tgz，内存中限定解压体积并只取普通 cloudflared 文件，不展开任意路径/符号链接；保留已校验 tgz，每次从可信归档校验/修复可执行缓存。不执行未校验下载。
7. close/shutdown 会取消准备并等待清理，不会下载完后偷偷 fork；新打开在准备/关闭过程中返回 busy。shutdown 后不再接受 open。测试/集成的自定义 `workerPath` 默认跳过组件准备，避免 fake 测试下载；`ensureCloudflared` 注入仅供离线测试。

## 来源、版本与许可

- 上游：https://github.com/cloudflare/cloudflared
- 固定发行页：https://github.com/cloudflare/cloudflared/releases/tag/2026.3.0
- SHA256 可信来源：https://github.com/cloudflare/cloudflared/releases/expanded_assets/2026.3.0 ，GitHub 官方 release asset metadata 的 `sha256:` 字段（非本机下载后自算后信任，也不调用受限 latest API）。
- 下载：https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/<官方文件名>
- Cloudflare cloudflared 采用 Apache License 2.0：https://github.com/cloudflare/cloudflared/blob/2026.3.0/LICENSE 。UPayNow 不内嵌改版二进制，按需获取上游组件；后续若发行包预置二进制，应一并保留上游 LICENSE/NOTICE。

升级需重新核对官方 metadata 并人工修改版本和完整摘要映射，不能将版本 URL 改为 latest 或信任运行时下载的 checksum。

## 给界面的错误码（均 HTTP 502）

| code | 中文建议 | English suggestion |
| --- | --- | --- |
| CLOUDFLARED_NOT_FOUND | 指定的 cloudflared 不存在或无法运行，请检查配置。 | The configured cloudflared is missing or cannot run. Check its configuration. |
| CLOUDFLARED_UNSUPPORTED_PLATFORM | 当前系统/架构不支持自动下载，请手动配置 cloudflared。 | Automatic cloudflared download is unavailable for this platform. Configure it manually. |
| CLOUDFLARED_DOWNLOAD_FAILED | 手机连接组件下载失败，请检查网络后重试。 | Could not download the mobile connection component. Check your network and retry. |
| CLOUDFLARED_INTEGRITY_FAILED | 手机连接组件校验失败，未执行该组件，请重试。 | Mobile connection component integrity check failed. It was not executed. Retry. |
| CLOUDFLARED_CACHE_FAILED | 无法写入手机连接组件缓存，请检查数据目录权限与磁盘空间。 | Cannot write the mobile connection component cache. Check data-directory permissions and free disk space. |
| TUNNEL_CLOSED | 手机连接已关闭，请重新打开。 | The mobile connection was closed. Open it again. |

离线验证（无需 cloudflared，不会打开公网隧道）：

```sh
node --test backend/test/cloudflared.test.cjs backend/test/managed-tunnel.test.cjs backend/test/tunnel-orphan.test.cjs backend/test/deployment-result-ack.test.cjs
```

真实环境下载成功不等于 Cloudflare 公网隧道验收；后者必须单独授权执行。
