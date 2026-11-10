# 管理 API

所有日期使用 ISO `YYYY-MM-DD`，时间戳使用 UTC ISO-8601，档案身份使用服务端生成的 UUID。

## 会话

1. `GET /api/auth/csrf` 返回 `{headerName, token}` 并建立会话。
2. `POST /api/auth/login` 使用表单编码发送 `username` 和 `password`，同时按第 1 步发送 CSRF 请求头；成功 `204`，账号或密码错误 `401`。
3. 登录成功后重新获取 CSRF token，后续操作携带会话 Cookie。
4. `GET /api/auth/me` 返回当前 `{username}`。
5. `POST /api/auth/logout` 携带 CSRF 请求头，成功 `204`。

管理接口需要 `ADMIN` 会话。没有登录返回 `401`，缺少或无效的 CSRF token 返回 `403`。会话 Cookie 使用 HttpOnly、SameSite=Strict；HTTPS 部署应设置 `MCM_COOKIE_SECURE=true`。

`GET /api/health` 不需要登录，只表示应用存活，不代表采集器、备份或数据库的完整就绪状态。

## 服务器档案

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/servers` | 返回所有档案，包括已封存，按开服日期降序 |
| POST | `/api/servers` | 新增，成功 `201` 并返回 Location |
| GET | `/api/servers/{id}` | 获取一份档案 |
| PUT | `/api/servers/{id}` | 编辑名称、介绍与开服日期；UUID 不变 |
| POST | `/api/servers/{id}/archive` | 封存，必须提供结束日期 |

新增与编辑的请求：

```json
{"name":"秋日生存服","description":"第一周目的记忆","startDate":"2026-10-01"}
```

名称必填、最多 80 字符，介绍必传、最多 2000 字符（允许空字符串），两者保存时去除首尾空白。

封存请求：

```json
{"endDate":"2026-10-26"}
```

成功响应包含 `id`、`name`、`description`、`startDate`、`endDate`、`status`、`createdAt`、`updatedAt`。`status` 为 `RECORDING` 或 `ARCHIVED`；记录中时 `endDate` 为 null。

- 不提供删除或重新开启入口。
- 同名档案可以存在，UUID 对应不同的一期。
- 结束日期不能早于开服日期；封存后编辑也不能破坏此约束。
- 重复封存返回 `409`，不会覆盖原结束日期。
- 不存在返回 `404`，字段/日期/UUID 格式错误返回 `400`。
- 档案封存不会停止游戏服务器、触发采集或生成备份。
- 已经采集数据后不能修改开服日期；名称和介绍仍可编辑。
- 封存日期不能早于已记录数据；封存时刻单独保存，以后编辑介绍不会移动这个边界。

采集凭据、批次写入见 [采集协议](采集协议.md)，玩家/行为/会话/死亡和跨服汇总见 [统计查询](统计查询.md)。

完整游戏归档上传、下载、备注、永久保留与最终封存记录见 [备份管理 API](备份管理.md)。这些操作不回滚或删除中央统计。

每服定期制作策略、乐观版本、保留预览及数量/天数轮换接口见 [验证范围](testing.md)，使用相同管理员会话与 CSRF 边界。

新目录恢复记录、占用与执行端受限下载见 [恢复任务协议](恢复任务协议.md)。中央协议已提供，宿主执行与网页向导继续实施。
