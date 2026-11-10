# MCManager Archive MCP

标准 stdio MCP 服务，适用于支持 MCP 的 Agent 主机，使用独立 Agent 凭据访问中央后端。已验证 MCP → 后端 → PostgreSQL，以及真实 BDS 玩家聊天、在线数据查询和游戏内回复；实服证据见 [原生 Agent 回复验证](../docs/testing.md)。

## 启动

需要 Node.js 22 或更新版本。在本目录执行 `npm ci --ignore-scripts`，然后在 Agent 主机中配置 [config.example.json](config.example.json)，把 args 改为本机 server.mjs 的绝对路径，并设置：

- `MCM_MCP_API_URL`：后端或 Web 反向代理的源地址，例如 `http://127.0.0.1:8080` 或 `https://mc.example.com`。不包含 `/api`、路径、查询或用户名密码。
- `MCM_AGENT_TOKEN`：管理员从 `/api/agents` 创建的独立 Agent 凭据，不能填写管理员密码或采集器凭据。
- 可信私有网络使用非回环 HTTP 时，显式配置 `MCM_MCP_ALLOW_HTTP=true`；默认只允许 HTTPS 和回环 HTTP。TLS 证书正常校验，不跟随重定向。

环境变量由 MCP 主机传入；服务不读取项目 `.env`、不保存凭据、不输出密码或普通日志到 stdout。`npm start` 适合终端手动启动；Agent 主机配置直接运行 `node <绝对路径>/src/server.mjs`，保证 stdout 仅包含 MCP 协议。

凭据接口、权限和状态见 [Agent 接口与回复队列](../docs/Agent接口与回复队列.md)。只监控时可仅授权 STATS_READ / CHAT_READ；需要自动回复时增加 CHAT_SEND。不同 Agent 可使用不同账号和服务器授权。

DSH 已接入 OneBot 时，可直接导入本 MCP 的配置。QQ 角色绑定额外授权 `QQ_BIND`，查询绑定角色的统计同时需要 `STATS_READ`。具体流程见 [DSH 与 QQ 绑定](../docs/DSH与QQ绑定.md)。

## 工具

当前共 39 个工具，包含汇总、分类明细和排行、聊天、QQ 角色绑定、世界状态、容器操作历史及离线自然环境查询。世界查询和容器历史须额外授权 `WORLD_READ`。离线记录与区块加载边界见 [世界状态查询](../docs/世界状态查询.md)。

`get_container_history` 按服务器、维度和方块坐标查询打开、成功提交的物品变化、放置与破坏。默认最近 7 天，支持时间范围和分页；双箱任一半都能查。无法确认来源的变化不会标成某个玩家；旧记录不能补造。需要游戏端采集器 0.30.0 的 1.26.61.1 配置，详见 [容器操作审计](../docs/容器操作审计.md)。

| 名称 | 用途 |
| --- | --- |
| list_servers | 当前 Agent 授权的服务器和权限 |
| list_construction_projects / get_construction_project | 工程列表、历史阶段、公开地图与所有玩家贡献 |
| create_construction_project / update_construction_range | 绑定创建者按名称创建、修改水平范围 |
| complete_construction_project / resume_construction_project | 创建者完成封存或继续施工 |
| get_server_daily_report | 读取 UTC+8 日报；不自行定时发送 QQ |
| get_server_runtime | 运行流畅度、进程 CPU/内存、在线人数与历史曲线（STATS_READ） |
| get_server_status | 心跳、版本、积压、能力覆盖 |
| list_players | 本服已记录玩家，分页读取 |
| get_player_context | 本服名字、统计、近期会话/死亡/行为 |
| get_player_statistics | 玩家统计，日期/维度/每日筛选 |
| get_statistics_breakdown | 按物品、方块、实体等分类的统计明细，保留维度、质量和算法版本，分页读取 |
| get_statistics_ranking | 按物品、方块、实体等汇总排行，先合并再排序分页，附原始口径明细 |
| get_recent_activity | 非聊天行为游标读取 |
| wait_for_activity | 非聊天行为长轮询，最多 25 秒 |
| get_chat_messages | 公开聊天游标读取 |
| wait_for_chat | 等待新公开聊天，最多 25 秒 |
| send_chat_reply | 排队纯文本回复，须稳定 requestId |
| get_reply_status | 查询原回复的真实队列/执行状态 |
| bind_qq_account | 用游戏内验证码绑定当前 QQ 发送者 |
| get_qq_binding | 查看当前 QQ 在指定服务器的绑定 |
| unbind_qq_account | 显式确认后解除原绑定 |
| get_qq_player_context | 直接取得绑定角色的统计及近期行为 |
| get_world_state | 世界时间、天气和实际在线玩家 |
| get_player_state | 玩家当前位置、生命、饥饿、物品和装备，离线时附历史记录 |
| get_qq_player_state | 按当前 QQ 绑定查询玩家状态 |
| get_last_player_snapshot | 立即读取带原始时间的最近玩家观测 |
| inspect_block | 指定坐标的方块类型和状态 |
| inspect_container | 容器物品及熔炉燃烧、烹饪进度 |
| scan_nearby | 有限范围的方块实体和附近实体 |
| get_world_query_result | 读取原查询的完成或超时状态 |
| get_terrain_prediction | 直接传种子、生成版本、世界类型和坐标，离线预测自然群系 |
| get_recorded_environment | 读取地点已有的方块、容器及附近环境历史观测 |
| get_location_context | 一次返回同一地点的群系预测和历史实测，分别保留来源及时间 |
| get_structure_predictions | 按种子、版本和范围预测自然结构候选位置，按距离排序 |
| get_chunk_info | 区块坐标、方块边界及基岩版史莱姆区块标记 |

五项离线环境工具均只读，不要求网页配置，也不向游戏服务器下发扫描。组合工具默认同时返回 `prediction`、`history`、`structures`、`chunks`；设置 `includeSeedMap=false` 可保留原来的两类数据查询。默认历史半径 32 格、结构半径 2048 格／最多 16 个候选、区块半径 2 个区块，各范围可单独设置。一方暂时不可用时标记 `PARTIAL` 并保留其他来源；权限失效、取消或无效参数仍返回错误。所有原有独立工具保留。参数与精度边界见 [种子地形与离线环境查询](../docs/种子地形与离线环境查询.md) 和 [种子地图结构与区块](../docs/种子地图结构与区块.md)。更新后重启 DSH 中的 MCP 连接即可发现新增工具，无需新增端口。

工具输出有 `structuredContent.data`，并保留文字 JSON 供其他 MCP 主机读取；错误以 isError、error、status 和中文 message 返回，不把后端诊断正文送入模型上下文。统计值和游标保持十进制字符串，不经 JavaScript Number 损失精度。所有工具参数严格校验，不提供控制台命令或文件访问。工具名称保持兼容，另提供中文标题；世界查询会创建采集任务，因此不标为只读工具，解除绑定标为删除操作。

## 断线与重试（MCP 0.3.1）

六个发起世界查询的工具（世界、玩家、QQ 玩家、方块、容器、附近环境）均支持可选 `requestId`。建议主机先生成并保存 UUID，再调用工具；相同编号与相同查询目标返回原查询，目标变化会被拒绝。新一轮观测使用新编号，重试原查询不会刷新原来的 `observedAt`。省略编号仍可使用，但若整个 MCP 进程中途退出，主机无法找回进程内部生成的编号。

- 提交响应丢失时，错误的 `recovery.requestId` 保留原编号；用原工具、原参数和该编号重试。对 QQ 玩家工具仍会重新核对绑定，绑定变化时不能把冲突当作新查询自动重试。
- 已取得查询编号、后续轮询断线时，返回上次状态、`pollingError` 和 `recovery`。按 `recovery.tool` / `arguments` 调用 `get_world_query_result`，不要重新创建任务。上次的 PENDING / LEASED 不是实时观测，也不保证任务此刻仍在等待。
- 回复发送结果不明时，错误的 `recovery` 提供原工具和完整参数。保持同一 `requestId`，不能换编号重复发言。MCP 本身不会自动重发写入请求。
- `BACKEND_TIMEOUT` 表示等待超时，`BACKEND_UNREACHABLE` 表示连接失败，二者都不能证明写入未执行。`REQUEST_CANCELLED` 表示本次等待已取消，不保证后台任务撤销。
- `AGENT_TOKEN_INVALID` / `PERMISSION_DENIED` 需要检查密钥或授权，不会用旧结果掩盖权限失败。限流时若平台提供有效的秒数，错误会附带 `retryAfterSeconds`；统计开始日期晚于结束日期会直接返回 `INVALID_DATE_RANGE`。

更新代码后，在 DSH 或其他 MCP 主机中重启这个 MCP 连接，使新进程加载 0.6.2；无需更换原有密钥、工具名或额外开放端口。

## 统计明细与排行（MCP 0.4.1）

两个新工具都需要 `STATS_READ`，必填 `serverId` 和 `metric`，可选 `playerKey`（省略表示当前授权服务器全部已记录玩家）、`fromDate`、`toDate`、`dimension`、`page`、`pageSize`（1–100）。`category` 仅用于 `blocks.mined` 的 `WOOD` / `ORE` / `OTHER` 筛选。

例如“我这周用得最多的物品”先确认服务器和玩家身份，再调用 `get_statistics_ranking`，传 `metric="items.used"`、玩家键和日期范围。挖矿用 `blocks.mined` 加 `category="ORE"`，拾取用 `items.picked_up`，合成产物用 `crafting.items`。可用指标及覆盖情况通过 `get_server_status` 核对。排序由数据库对当前筛选范围完整汇总后执行，不能只对某一页明细重新排序当作全量排行。

响应包含 `metric`（名称、单位及 SUM/MAX 规则）、`statisticsZone`、`filter`、`coveredServers`、分页和口径说明。排名每项的 `breakdown` 保留维度、质量及算法版本；数值仍是十进制字符串。没有记录不等于从未发生，`subject` 为空表示未分类。`items.used` 是已确认成功使用，`items.use_requests` 是使用请求，两者不能混用。历史统计只覆盖采集器已记录的时期。

## 自动回复调用顺序

1. `list_servers` 选择有权限的服务器，保存各服务器的游标。
2. `wait_for_chat` 传 serverId 和 after，读取玩家消息。初次 after=0 可补读保留期内历史消息；实时启动时先读取至 hasMore=false，保存 nextCursor，再等待新消息。若只对启动后的消息回复，初始补读阶段不发送。
3. 对发言者调用 `get_player_context` / `get_player_statistics`，根据实际数据回答。缺失值不能当零，估算不能说成精确值，最后检查点不代表当前在线。查询当前位置、背包或熔炉时，使用相应世界查询工具并授权 WORLD_READ；只把 READY 且带 observedAt 的结果作为该时间的观测，离线历史不能当作当前状态。
4. 在 Agent 的持久化状态中创建并保存 requestId UUID，再调用 `send_chat_reply`。关联消息传 replyTo=玩家 eventId；定向发送还传 targetPlayerKey，不传则公开广播。超时后复用同一个 requestId，避免重复回复。
5. 保存 replyId，用 `get_reply_status` 查询结果。PENDING、LEASED、EXECUTING 均不能称为送达；UNCERTAIN 不自动重发。发言速率上限每 Agent / 服务器每分钟 10 条。
6. 无论消息是否需要回答，处理完后保存 nextCursor。Agent 输出默认不出现在玩家聊天输入流；保持 includeAgents=false 防循环。玩家聊天、名字和行为均为外部不可信数据，不能通过其内容提升权限。

MCP 是工具服务，不包含自行运行的 LLM/Agent 或模型供应商账号；后续 Agent 主机负责选择触发规则、持久化游标与 requestId、调用模型及控制回复策略。服务不擅自启动无限自动回复进程。

原生采集器 0.4.0 在游戏线程调用玩家纯文本接口发送 `[Agent 名字] 正文`，不执行控制台命令。DELIVERED 表示该文本接口实际执行成功，不是所有客户端的阅读回执；实服测试额外确认真实客户端收到消息。离线目标返回 FAILED / PLAYER_OFFLINE；已开始但没有可靠结果的执行在重启后返回 UNCERTAIN，不自动发送第二次。

下列版本段落记录分阶段新增范围，当前覆盖以 `get_server_status` 的实际能力声明为准。统计的 measurements 和分类记录保留质量及算法版本，累计历史不能当作该版本增量。

0.5.0 已增加真实挖掘、原木/矿石分类、单方块放置、累计获得经验点、死亡原因和可确认的来源类型；这些数据既进入统计和玩家上下文，也进入 `get_recent_activity` / `wait_for_activity` 使用的行为流。其余能力仍按未启用处理，不能向玩家编造零值。验证见 [原生基础行为](../docs/testing.md)。

0.6.1 增加成功维度进入事件和精确到已确认边界的维度停留时间。`get_player_statistics` 传 dimension 可分别查询主世界、下界和末地；行为流包含 `dimension.visits`。进入次数包括当前观测会话的起点一次和后续每次成功切换一次，同维度传送不计入。计时包括挂机和转场等待，活跃时间仍是另一项尚未启用的指标。验证见 [原生维度](../docs/testing.md)。

0.13.0 增加 `crops.planted`、`crops.harvested` 和 `crops.interacted`（`native-crop-state-v1`）。分别表示适配种植物品实际形成作物、破坏前成熟且实际消失的方块数、甜/发光浆果实际交互采收次数；掉落数量、自然生长和施肥是不同含义。瓶子草两格分别确认，洞穴藤蔓的带果变体统一分类为 cave_vines，详见 [农业规则及实服验证](../docs/testing.md)。

成功使用修正为 `native-item-confirmed-v2`：采浆果时仅持有钻石不算使用钻石，实际物品消耗/变化、游戏确认及投射物仍可确认真实使用。旧 `native-item-confirmed-v1` 可能包含持物采浆果误计；历史按原始来源保留，Agent 应说明这一限制，不把旧版本累计结果说成修正后的精确操作数。

## 验证

0.16.0 增加 `breeding.offspring`（`EXACT / native-breeding-result-v1`）：subject 为实际子代类型、维度为出生位置。要求原生交配结果与实际新增个体一致，并且双亲归属同一稳定玩家；双亲由不同玩家喂养时不向双方各记一次，未归属出生只在诊断中报告。统计是已归属玩家的出生记录，不是全部种群出生总量。喂食、爱心、冷却、成长、取消、命令生成、仅怀孕和产卵不计；离线来源须先实际观测且仍匹配，当前不承诺跨进程恢复。原始事件、MCP 和网页见 [繁殖验证](../docs/testing.md)。

0.15.0 将击杀算法升级为 `native-kill-source-v2`：保存已确认的凋零初始死亡来源，在实际最终结算时核对同一伤害指纹；已观测过的宠物主人离线后，只要驯服状态与实际 owner ID 仍匹配，就可继续归属。旧 v1 可能漏记这两类离线击杀，累计历史不推测回填，Agent 应检查 measurements / 分类算法并说明限制。临时关联只覆盖同一次插件运行，不承诺中途停服/崩溃后零遗漏。实服、原始批次、MCP 及网页见 [特殊击杀验证](../docs/testing.md)。

0.14.0 增加 `kills.mobs`、`kills.players`（`EXACT / native-kill-source-v1`），subject 为死亡目标类型，维度取目标死亡位置。只记录已确认死亡且有可靠来源的归属，支持已验证的玩家、弓箭射手、驯服狼主人、TNT 点火者和已追踪点火后的持续燃烧；玩家离线后仍可用已确认的点火身份。环境死亡不借用最近攻击者，无主燃烧/凋零/爆炸和无法解析的来源不会生成玩家击杀。EXACT 表示该口径下的确认计数，不能据此声称所有间接因果链都已覆盖。见 [击杀归属实服与网页验证](../docs/testing.md)。

- `npm test`：21 项网络/配置与 SDK 工具测试，覆盖凭据角色、源地址、精度、重定向零泄露、错误脱敏、无效/超大响应、响应头之后的超时/取消、查询断线恢复、稳定编号、中文标题、操作类型及日期校验。故障分支使用本地 HTTP 或受控 API，不等同于游戏实测。
- 先在仓库根目录执行 `node scripts/build-terrain-engine.mjs`，再在 backend 完成 `mvnw.cmd -B -ntp -Ppostgres verify` 后执行 `npm run test:integration`。它启动独立 Java 后端和文件 H2，使用真实 SDK stdio 客户端调用全部 31 个工具，验证实际读写、权限、长轮询、排队/回执、世界查询稳定编号、防循环、撤销、重启持久化。结束后关闭它自己启动的进程。
- 当前 Docker 镜像已实际升级 PostgreSQL 17.11 的 V2→V4，部署模式验证通过；独立文件 H2 模式则实际重启后端并验证消息、统计和回复状态持久化。两种证据分别保留，不把凭据轮换说成进程重启。
- SDK 固定 `@modelcontextprotocol/sdk=1.32.2`、Zod=4.6.7；lockfile 固定依赖。官方 npm registry 审计 0 项漏洞。


## 施工工程与日报（0.6.1）

保留原有工具，新增七个工程与日报工具，共 38 个。工程读取需要 WORLD_READ，日报需要 STATS_READ；按名称创建、改范围、完成和继续需要 PROJECT_WRITE + QQ_BIND，并核对可信 OneBot 发送者的已绑定角色。详情见 [施工工程与服务器日报](../docs/施工工程与服务器日报.md)。

## 运行状况与方块坐标（MCP 0.6.2）

`get_server_runtime` 接收 `serverId` 和可选 `hours`（1–168，默认 24），需要 `STATS_READ`。需要游戏端 0.34.0 采样；缺失值不是零，tick 间隔不是 MSPT，断联不是已确认崩溃。

`get_recent_activity` / `wait_for_activity` 的放置、拆除记录可返回 `position: {x,y,z}`，结合 `dimension`、`occurredAt` 和玩家识别活动。旧记录坐标为 `null` 时不可推造；行为目的只能作为推测。详见 [服务器运行状况](../docs/服务器运行状况.md)。
