# UPayNow 加密备份与隔离恢复核验

**简体中文** | [English](OPS-BACKUP.en.md)

以下命令在 Linux 本地文件系统运行，需安装 Node.js 22.19+ 和系统 `flock`。先在**全新的、无真实业务数据的测试实例**演练。备份工具不启停应用、不联网、不打开钱包、不发送交易或回调。当前没有生产调度或自动切换功能。

## 备份流程

1. 确认 UPayNow 实际数据根目录，而不是仅凭仓库默认路径。另备份版本号、应用部署配置和环境配置：数据目录之外的文件不会自动收入归档。
2. 从授权的维护流程正常停掉应用及任何共用目录的进程、脚本和外部写入者，并在备份期间保持它们停止。`--offline` 是操作者对这一前提的确认，不是检测开关。工具在整个归档期间保持根目录及部署子目录的实例互斥锁；已有或无法确认的锁会导致备份失败，工具不会移除它们。不能用看起来过期的 PID 替代停机协调。
3. 准备三个独立的、由运行命令的用户所有且权限为 `700` 的目录，分别存放归档、密钥和恢复演练数据；均不得在 UPayNow 状态目录下。路径中不能有符号链接。
4. 生成一次随机密钥，分别安全保存密钥和归档。密钥是 32 字节原始随机数据，不是口令；不得提交到代码库、发到聊天或与归档同存。丢失密钥后不能解密已有备份。

```sh
node scripts/ops-backup.cjs keygen /private/key-store/upay.key
node scripts/ops-backup.cjs create --offline /absolute/test-state /private/archive/test.upaybak /private/key-store/upay.key
node scripts/ops-restore.cjs verify /private/archive/test.upaybak /private/key-store/upay.key /private/encrypted-scratch
```

归档包含状态目录中全部普通文件和目录（包括 SQLite 数据库及仍存在的 WAL/SHM、认证、部署注册、订单、扫描与通知状态、密钥和未决任务），只排除根和部署目录内的所有权锁／护栏及其临时标记。拒绝符号链接、硬链接和特殊文件。输出仅含 AES-256-GCM 加密认证的归档，不覆盖已有文件。原始数据上限 64 MiB、10,000 项、32 层；归档和恢复过程需要额外内存。超限时工具拒绝执行，不会静默跳过文件。

## 仅在隔离目录核验或提取

两个恢复子命令都会先认证归档，在指定的私密父目录内新建随机子目录，再将**明文副本**写到这个子目录。建议使用专门的加密临时磁盘。工具不覆盖任意目标目录，也不会启动应用。它核对提取字节与已认证的归档，并离线只读运行 SQLite `quick_check`，检查根数据库中登记的每个部署是否有对应库及认证文件是否完整。SQLite 可能再生成临时 WAL 共享内存。

- `verify`：验证结束后清理这次创建的临时副本。
- `extract`：验证成功后保留新的私密目录，输出路径供进一步离线检查。

```sh
node scripts/ops-restore.cjs extract /private/archive/test.upaybak /private/key-store/upay.key /private/encrypted-scratch
```

进程被强制停止、机器掉电等中断有可能留下私密目录里的明文，事后应检查并按本组织的数据处理流程清理。不要用生产 RPC、实时回调或钱包验证这个副本。真实故障切换应先保持生产写入停止，核对应用版本和隔离配置，并逐笔对账备份时间点之后的链上交易及商城履约；本工具不执行生产切换。
