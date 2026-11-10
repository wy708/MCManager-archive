# 兼容矩阵

| 组件 | 此预发布版本 / 条件 |
| --- | --- |
| 平台发行 | 0.7.0-preview.1；不是全部子模块版本号 |
| Web / API | 源码包内固定依赖；Java 21、Node.js 24 构建 |
| 数据库 | PostgreSQL 17；H2 仅用于开发和隔离测试 |
| 原生采集器 | 0.38.0；Windows x64 |
| 主功能游戏配置 | BDS **1.26.61.1** + LeviLamina **26.60.2** + 本仓库精确兼容层 |
| 保留的旧配置 | BDS **1.26.51.1** + LeviLamina **26.51.8**；功能不完全相同 |
| MCP | 0.6.2；Node.js >=22，推荐与平台构建一致的 24 |
| 备份/控制执行端 | 0.7.0；Node.js >=22，Windows 游戏主机 |
| 地图插件补丁 | MipMap 1.0.3+mcmanager.6；Windows runtime 必须匹配固定清单 |
| 场景转换 | Java 21、Node、Python 3 构建；Linux 使用 Xvfb |
| DSH `/ai` | 已有 QQ 桥接与对应补丁目标；检查不匹配时停止安装 |

**不能只改版本字符串来适配任意 BDS。** 原生符号、布局、运行文件哈希和钩子都可能变化。兼容层的身份清单位于 `collector/runtime-compat/identity.json`，地图运行库位于 `map/compatibility/`。

原生构建方式见 [collector](../collector/README.md)。预发布不附带 Minecraft 服务端；需要自行从官方获得对应版本。不要混装两个配置的 DLL、SDK 或数据包。

种子预测声明支持的生成版本由 `terrain/sources.json` 和 API 校验决定。预测是候选，不能替代世界存档或服务器实测。

场景资源固定版本见 `scene/sources.json`。这不代表所有方块/实体/资源包均逐项验收；缺失内容必须在页面报告，不应用近似方块冒充完整还原。
