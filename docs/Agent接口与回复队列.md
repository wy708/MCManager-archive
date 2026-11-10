# Agent 接口与回复队列

中央后端和原生采集器的游戏内回复已实现，并通过真实隔离 BDS 客户端验证。MCP 客户端复用以下独立权限接口。

管理员现在也可从网页侧栏“Agent 接入”管理这些授权和凭据，创建/轮换时一次性显示凭据并复制 MCP 配置，关闭弹窗即清除显示。桌面、手机和小屏测试覆盖实际后端权限变化，见 [验证范围](testing.md)。

## 管理员发放凭据

所有 `/api/agents` 操作要求管理员登录会话；写入还要求 CSRF。POST 请求示例：

```json
{"name":"玩家助手","grants":[{"serverId":"服务器 UUID","scopes":["STATS_READ","CHAT_READ","CHAT_SEND"]}]}
```

响应只在创建或 POST `/{id}/rotate` 时返回一次 `token`，格式 `mcmagent.<Agent UUID>.<随机秘密>`。数据库仅存 SHA-256，列表不返回秘密。PUT `/{id}/grants` 替换授权；DELETE `/{id}` 撤销凭据，保留审计。轮换会使旧凭据立即失效，已撤销账号轮换后重新启用。

Agent 使用 `Authorization: Bearer <token>`，不能使用管理员会话或采集器凭据。

| 接口（前缀 `/api/agent`） | 权限与含义 |
| --- | --- |
| GET `/servers` | 只返回授权服务器及自身权限 |
| GET `/servers/{server}/status` | STATS_READ，实际采集版本、心跳及能力 |
| GET `/servers/{server}/players?page=1&pageSize=25` | STATS_READ，本服观察到的玩家名字与身份 |
| GET `/servers/{server}/players/{key}/context` | STATS_READ，本服名字、统计、最近 10 次死亡/会话、最近 20 条非聊天行为 |
| GET `/servers/{server}/statistics` | STATS_READ，playerKey/fromDate/toDate/dimension；daily=true 返回每日趋势 |
| GET `/servers/{server}/activity` | chat=false 要求 STATS_READ；chat=true 要求 CHAT_READ |
| POST `/servers/{server}/replies` | CHAT_SEND，排队纯文本回复；关联消息还要求 CHAT_READ |
| GET `/replies/{id}` | 仅原 Agent 且仍有该服 CHAT_SEND 可查询 |

行为流 after/limit/playerKey/includeAgents 与管理员行为接口一致；waitSeconds=0-25 是有上限的长轮询，不持有数据库事务等待。提交新事件或撤销权限会唤醒等待者，返回前再次鉴权。默认只读玩家消息，Agent 回执不会循环触发自动回复。

上下文不复用全局玩家档案：同一身份在未授权服务器使用的名字、参与服务器列表、死亡、会话和统计均不返回。升级前无法证明名字来源时返回稳定玩家键。null、估算及最后检查点保留实际含义，不声称具备实时背包或在线位置。

## 回复请求与执行

请求字段：requestId UUID、replyTo 可选玩家公开消息 UUID、targetPlayerKey 可选、text 纯文本 1-512 字符、ttlSeconds 10-300。稳定 requestId 重试返回同一记录，改内容冲突；同 Agent/服/玩家消息只能建立一条回复。每 Agent 每服每分钟最多 10 条；定向回复必须对应本服玩家，关联消息时目标必须是原发言者。返回 PENDING 不表示已发送。

采集器使用自己的服务器凭据，通过 `/api/ingest/v1/commands`：

1. POST `/claim`，JSON bootId；须匹配最近 120 秒内该服心跳。一次仅领取一条，30 秒租约，重复领取返回原租约。
2. 本地持久化命令记录，然后 POST `/{id}/begin`，JSON leaseId/bootId。重新校验服务器状态和 Agent 权限，进入 EXECUTING。
3. 采集器须在游戏线程使用文本 API；执行前后本地日志保证不会因 begin/ack 响应丢失而重复发送。
4. POST `/{id}/ack`，JSON leaseId/bootId/outcome/sentAt/errorCode。DELIVERED 必须带实际毫秒发送时间，无错误码；FAILED/UNCERTAIN 带 PLAYER_OFFLINE、SEND_FAILED 或 LOCAL_STATE_UNCERTAIN，无 sentAt。

未开始的 LEASED 到期或换 boot 可重新领取；EXECUTING 到期、换 boot、封存或失去权限后进入 UNCERTAIN，绝不自动重新领取。真实的延迟送达回执可以把 UNCERTAIN 解析为 DELIVERED；重复相同回执不会新增聊天。只有 DELIVERED 生成 source=AGENT 的聊天记录，不计入玩家发言次数。撤销权限取消 PENDING/LEASED，封存后禁止新回复。当前状态清理由队列访问触发。

## 验证

`backend/mvnw.cmd -B -ntp -Ppostgres verify`：H2 + 实际 PostgreSQL 17.11 共 82 项通过。新增覆盖独立角色/权限、跨服身份隔离、旧名字不泄露、旋转/撤销、长轮询唤醒/超时/撤销、并发幂等、消息关联、速率/文本校验、跨服与启动身份租约、未执行重租/已执行未知、延迟回执、来源防循环与封存。进一步验证未参与本服的玩家无论是否存在于其他服，查询错误完全相同，避免用错误信息探测跨服身份；无效 Unicode 拒绝，正常表情完整保存。

这些后端测试中的执行回执由协议测试提交；另有独立的 [验证范围](testing.md) 覆盖真实客户端收发、原生执行日志、离线失败和进程崩溃后的回执恢复。两类证据分别记录。
