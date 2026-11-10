# MipMap 世界地图

沿用 [MipMap](https://github.com/MipaSenpai/MipMap) 原版网页、地图服务与插件，包含明确标记的兼容补丁。Web 固定提交 `c30998792eba2d25ee9fa86b40594629bbf28c34`，插件基于官方 1.0.3，当前补丁版本 **1.0.3+mcmanager.6**。

保留三维度、玩家头像、缩放、坐标查看与区域补绘；增加坐标跳转、手机初始区域定位、透明方块下层叠图、状态材质映射和上传合并。下界按已采集的高度层查看，不将顶部基岩当作地下完整场景。

## 单服部署

填写项目 `.env` 中的以下变量：

```dotenv
MCM_MAP_SERVER_ID=REPLACE_WITH_SERVER_UUID
MCM_MAP_PUBLIC_URL=https://map.example.com
MCM_MAP_PORT=18091
MCM_MAP_BIND=127.0.0.1
MCM_MAP_INGEST_KEY=REPLACE_WITH_RANDOM_64_HEX_CHARACTERS
```

```sh
docker compose -f compose.yaml -f compose.map.yaml up -d --build
```

由 HTTPS 反向代理转发地图服务。公开 URL 必须从访客设备可达。地图查看无需登录；上传经私有随机路径转发，原始内部上传接口不发布。

## 多服

每服使用独立 MipMap 服务、卷与密钥。复制 [servers.example.json](servers.example.json) 成忽略的 `servers.local.json`，填写 UUID 与密钥环境变量名：

```sh
python3 map/configure_maps.py --config map/servers.local.json --public-origin https://map.example.com
docker compose -f compose.yaml -f .tools/map-generated/compose.json up -d --build
```

同一个网关通过 `/maps/<server-id>/` 区分服务器，不必每服新增公网端口。共享管理网页端口的配置见 [部署指南](../docs/deployment.md)。生成配置含私有上传路径，不要提交到仓库。

## 游戏端

必须匹配精确 BDS、LeviLamina、Endstone/LeviStone 配置，见 [兼容矩阵](../docs/compatibility.md)。新配置的上游版本、校验值和补丁位于 [compatibility/sources.json](compatibility/sources.json) 与 [compatibility/verified-artifacts.json](compatibility/verified-artifacts.json)。

`prepare_plugin.py` 校验固定官方 wheel，再生成标记过的修改版。Windows 发送子进程延迟加载游戏库，避免 spawn 重复初始化运行时；上传任务合并最新数据并限制并发。不要拿未知 wheel 绕过哈希校验。

修改配置或替换插件前正常停服；保留现有地图瓦片与配置。旧瓦片不会因改贴图自动成为新采集结果，需要在适当范围补采。

## 范围与成本

未采集区域仍为空白。坐标跳转只移动浏览器视角，不传送玩家、不触发扫描。大范围 `/loadmap` 会增加游戏负载；原版命令可能清除现有 tickingarea，正式世界使用前确认上游行为。

[透明方块](../docs/世界地图透明方块更新.md) · [上传优化](../docs/世界故事馆与上传优化.md) · [MipMap MIT](MIPMAP-LICENSE.txt)
