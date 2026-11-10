# 游戏主机执行端与世界备份

当前执行端 **0.7.0**，Node.js >=22，面向 Windows 游戏主机。包含控制台托管、在线世界快照、归档校验与恢复任务。默认备份范围为 **WORLD**；完整程序目录备份是另一个明确选择的范围。

## 安装

```powershell
npm ci --prefix backup --ignore-scripts
```

在网页「备份中心」创建该服执行端，复制 [host.config.example.json](host.config.example.json) 到游戏目录之外的私有路径，填写平台地址、游戏目录、备份目录和档案 UUID。使用该执行端的独立凭据，不能填 Agent 或采集器令牌。

正常停止原有游戏进程后启动托管控制台：

```powershell
$env:MCM_HOST_TOKEN = 'REPLACE_WITH_HOST_TOKEN'
node backup/src/console-host.mjs --config 'D:\MCManagerHost\host.json' --start
```

同一游戏目录只能有一个执行端。进程冲突、恢复状态不确定时先检查诊断，不要删除状态文件强行重试。

## 只备份世界

正常停服后可手动制作归档。输出目录必须存在且位于游戏目录之外，文件不可覆盖：

```powershell
node backup/src/cli.mjs create --root 'D:\Minecraft\server' --output 'D:\WorldBackups\maintenance.tar.gz' --server-id '档案UUID' --scope WORLD --note '维护前'
node backup/src/cli.mjs verify --file 'D:\WorldBackups\maintenance.tar.gz'
```

WORLD 保存选定世界及其建筑、地形、容器、玩家数据等，不复制插件 outbox、程序、运行日志或其他世界。LevelDB 的 WAL 属于存档数据，不能按普通日志删除。

## 在线备份与计划

原生采集器通过 `save hold/query/resume` 协调世界快照。执行端按游戏返回的文件长度复制，确认释放快照后压缩和校验；游戏可在复制期间继续运行，但快照准备不是零开销。

在网页按服务器配置每天执行时间与保留策略。计划默认关闭，中央服务需持续运行。任务只有上传和校验成功后才成为可下载的备份；本地文件变大不代表已经上传完成。

## 恢复边界

使用网页恢复向导或受控恢复流程，目标必须是独立空目录。世界归档不含 BDS、框架与插件，需准备匹配的运行环境。文件校验通过不等于实际玩家已成功进服；应独立启动并验证存档。

备份与恢复日志绑定任务/档案，断线保持原请求身份，结果不确定时不自动重放覆盖。不要清理正在使用的隐藏任务目录。

[完整说明](../docs/世界存档备份.md) · [任务协议](../docs/远程备份任务协议.md) · [恢复协议](../docs/恢复任务协议.md) · [控制台](../docs/网页服务器控制台.md)
