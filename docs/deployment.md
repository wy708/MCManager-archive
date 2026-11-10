# 部署与运维

## 服务组成

默认 `compose.yaml` 从源码构建 web 与 backend，并启动 PostgreSQL。仅 web 发布端口；数据库、API、转换器在 Compose 网络内通信。`compose.production.yaml` 适用于已经构建并标记镜像的部署，不是远程镜像仓库的承诺。

```sh
python3 scripts/configure.py --public-url https://mc.example.com
docker compose up -d --build
```

默认绑定 `127.0.0.1:8088`，由同机 HTTPS 反向代理转发到该端口。代理需要保留 Host、转发协议和请求体，并允许备份上传的相应体积。若代理运行在别的主机或容器网络，显式选择可达的绑定地址，并用防火墙限制来源。

`MCM_PUBLIC_BASE_URL` 必须与访客使用的源地址一致；HTTPS 配置使用 Secure 会话 Cookie。不要为了绕过部署错误关闭 TLS 校验。反向代理、WAF 和插件的超时/上传大小限制需一致。

## 持久数据

| 数据 | 保存位置 |
| --- | --- |
| 档案、玩家、事件、工程、权限和任务元数据 | PostgreSQL `database` 卷 |
| 上传的备份、场景缓存与导出结果 | `backups` 卷的应用数据目录 |
| MipMap 瓦片 | 单独部署的每服地图卷 |
| 尚未确认上传的游戏行为 | 游戏插件 outbox |
| 原始游戏世界 | 游戏服务器的 worlds 目录 |

这些不是同一份备份。世界备份不包含平台数据库；数据库备份也不能替代游戏世界与地图瓦片备份。恢复前核对版本、档案归属和文件校验，始终使用独立空目录验证。

## 多服与地图

平台用档案 UUID 隔离各服。每服创建独立采集、执行端和地图上传凭据。地图可以通过共同网关的 `/maps/<server-id>/` 分享，无需每服增加一个公网端口；内部仍是独立地图服务。见 [地图部署](../map/README.md)。

共享网页端口的 Nginx 生成器：

```sh
python3 map/production_gateway.py SERVER_UUID /private/map-upload-key.txt /private/nginx.conf https://mc.example.com
```

生成配置包含上传密钥，应保存在权限受限的部署目录。默认平台 Compose 不会自动绑定此配置或创建地图容器；参考地图 Compose 及生成器进行接入。切勿把上传密钥放到公开地图链接。

## 更新与回滚

1. 记录组件版本并备份数据库、文件卷及配置。
2. 在测试环境构建新版本、验证数据库迁移和权限。
3. 替换镜像后检查健康状态、登录、查询和一条真实采集记录。
4. 游戏端更新需正常停服；保留旧配置，按精确版本说明替换二进制。
5. 回滚应用前确认数据库迁移是否向后兼容；必要时恢复配套备份，不能只降级程序。

仅改前端时可以只更新 web 服务。不要使用删除卷或清空 outbox 作为常规排错步骤。
