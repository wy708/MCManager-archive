# 快速开始

## 1. 启动空平台

安装 Docker Engine、Compose v2 和 Python 3。从发布页下载 `MCManager-Archive-0.7.0-preview.1-source.zip`，或克隆本仓库。

在源码根目录运行：

```sh
python3 scripts/configure.py --public-url http://localhost:8088
docker compose up -d --build
docker compose ps
```

配置程序随机生成初始管理员和数据库密码，写入 `.env`，拒绝覆盖已有文件。Linux 使用 0600 文件权限；Windows 请另外限制该文件的访问账户。打开 `http://localhost:8088`，使用 `.env` 的 `MCM_ADMIN_USERNAME` / `MCM_ADMIN_PASSWORD` 登录。

首次镜像构建需要下载 Maven/npm 依赖、MiEx、固定游戏资源和种子预测引擎。构建网络必须能访问其上游。可用磁盘与内存需求随世界规模增长；不要把本说明当成大规模容量保证。

## 2. 接入游戏

1. 在「服务器档案」创建一台服务器，保存档案 UUID。
2. 在「平台设置 → 游戏插件连接」创建该服独立采集凭据。
3. 按 [兼容矩阵](compatibility.md) 准备精确版本的 Windows BDS 与原生插件。
4. 正常停服后安装，填写 `collector/config.example.json` 对应的服务器、地址和凭据，再启动。
5. 检查网页心跳、版本与能力覆盖，然后用测试玩家产生一条记录，确认实际上传。

不要覆盖正在运行的 DLL，不要把另一服的 outbox 复制过来。初次接入只能记录之后的行为，无法凭空补齐历史。

## 3. 按需开启

| 功能 | 下一步 |
| --- | --- |
| 世界地图 | [地图说明](../map/README.md)，每服独立数据卷与上传密钥 |
| 工程与三维 | [工程说明](施工工程与服务器日报.md)、[场景转换](../scene/README.md) |
| AI 工具 | [MCP 安装](../mcp/README.md)，在「AI 助手」创建最小权限凭据 |
| 游戏 `/ai` | [DSH 桥接](游戏内AI与DSH.md)，需要已有 DSH 与 QQ 桥接 |
| 世界备份 | [世界备份](世界存档备份.md)，安装独立游戏主机执行端 |
| 每日计划 | 「备份中心」按服务器配置每天几点执行；默认不自动启用 |

## 4. 公网与升级

正式对外服务前，阅读 [部署指南](deployment.md) 和 [安全策略](../SECURITY.md)。公开地址必须是访问者能连接的域名，不能使用部署机器的回环地址。

升级前备份 PostgreSQL 和文件卷，保留上一版镜像。先升级平台，再按对应说明升级 MCP / 游戏端。不要执行 `docker compose down -v` 清理生产环境，它会删除卷。
