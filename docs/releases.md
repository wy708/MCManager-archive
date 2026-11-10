# 发布与下载

平台版本描述整套源码快照，组件保留独立版本号，参见根目录 `release.json`。

## 选择下载内容

| 文件 | 用途 |
| --- | --- |
| `MCManager-Archive-0.7.0-preview.2-source.zip` | 完整源码与文档，从 Docker Compose 构建平台 |
| `MCManager-MCP-0.6.2-source.zip` | MCP 源码；需要 Node.js 和 `npm ci`，不是内置 Node 的便携包 |
| `MCManager-Host-0.7.0-source.zip` | 游戏主机执行端源码；需要 Node.js、依赖及私有配置 |
| `MCManager-Collector-1.26.61.1-0.38.0-update.zip` | 已有匹配框架/兼容层的游戏服更新采集 DLL，不是首次安装整合包 |
| `SHA256SUMS.txt` | 附件完整性校验 |

首次游戏端安装必须按 [兼容矩阵](compatibility.md) 和 [采集器构建](../collector/README.md) 准备精确依赖。源码与更新包均不包含 Minecraft 服务端、世界数据或账号凭据。

校验下载：Linux 使用 `sha256sum -c SHA256SUMS.txt`；Windows 使用 `Get-FileHash -Algorithm SHA256` 对照清单。校验和用于发现下载损坏，不代替可信来源与签名。

## 维护者打包

提交完整的公开源码，然后运行：

```sh
python3 scripts/check-public.py
python3 scripts/package-public.py --output /path/to/new-release-directory
```

输出目录必须不存在。打包仅使用已跟踪、已提交的源码；不会打包运行文件夹或未跟踪文件。压缩包内固定元数据，便于同一源码重现。

原生更新包另从精确配置的已编译 DLL 制作，检查版本与二进制调试路径，保留独立安装说明。Gitea/GitHub 发布时标为 **Pre-release**，逐个上传附件后重新下载比对 SHA-256。
