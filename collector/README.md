# 原生采集器

当前版本 **0.38.0**，Windows x64。主要功能配置为 BDS **1.26.61.1 / LeviLamina 26.60.2**，必须同时使用本仓库的精确运行兼容层。旧 **1.26.51.1 / 26.51.8** 配置保留，但不包含全部新功能。详见 [兼容矩阵](../docs/compatibility.md)。

## 构建

需要 Visual Studio 2022 C++ 工具、Windows SDK、clang-cl、Git、Node.js 与 xmake >=3.0。

```powershell
node scripts/prepare-collector-sdk.mjs --runtime=1.26.61.1
cd collector
xmake f -y -m release --native=y --runtime=1.26.61.1
xmake -y -j 4 archive-collector
cd ..
./scripts/build-runtime-compat.ps1
```

采集器输出位于 `collector/bin/1.26.61.1/archive-collector/`；兼容层输出位于 `collector/build/runtime-compat/AAA-archive-runtime-compat/`。保留插件包名和预加载顺序，按 `identity.json` 核对 BDS、PreLoader 与框架，不能混用其他版本。

只构建不依赖游戏 SDK 的核心测试：

```powershell
cd collector
xmake f -y -m release --native=n
xmake -y verify-collector-core
xmake run verify-collector-core
xmake -y verify-ai-mailbox
xmake run verify-ai-mailbox '<尚不存在的临时邮箱目录>'
```

测试通过不等于已对某个真实世界完成游戏联调。

## 安装与配置

正常停服后，将两个插件目录放入游戏的 `plugins/`。使用 [config.example.json](config.example.json) 填写档案 UUID、平台采集地址和专用凭据，保留原有配置及数据。插件启用后核对网页心跳和能力覆盖，再测试一次真实行为。

版本不匹配、身份检查失败或符号解析不满足时应拒绝启动；不要修改检查值绕过保护。服务端程序不随公开源码分发。

## 持久化和性能

outbox 绑定服务器档案，通过独占锁和持久批次保存原始编号。仅在收到匹配的 JSON 收据后确认上传；断网或 TLS 失败保留待上传数据。中央按稳定身份幂等处理，重试不会重复累计。

磁盘和网络工作在后台；游戏线程负责有限采样和必要的游戏操作。整机采样约每 10 秒一次，随已有批次上传，停服后不继续监控。大量玩家或大规模场景仍需压力测试。

## 功能说明

[世界观测](../docs/世界状态查询.md) · [容器审计](../docs/容器操作审计.md) · [施工工程](../docs/施工工程与服务器日报.md) · [游戏 AI](../docs/游戏内AI与DSH.md) · [采集协议](../docs/采集协议.md)

没有采集到的旧事件无法补造。指标的成功判定、估算质量和算法版本必须与其元数据一起解释。
