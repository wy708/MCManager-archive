# Statistics loading

The world stories page requests only the dataset needed by the selected chart.
Existing callers that omit `part` still receive the complete response.

| Endpoint | Supported `part` values |
| --- | --- |
| `/api/statistics/exploration` | `all`, `metadata`, `hours`, `contributions`, `hotspots`, `heights`, `ranking` |
| `/api/statistics/exploration/extended` | `all`, `daily`, `players`, `runtime`, `milestones` |

For a partial response, unrelated lists are empty. `coverage` is populated for
`all`, `hotspots`, and `heights`; otherwise it is `null`. Empty unrequested lists
must not be interpreted as a zero total. Authorization and date-range validation
apply to every section. Cache keys include the server, date range, time zone and
section. Server snapshots retain the existing two-minute freshness window.
The page also reuses up to eight snapshots until their original expiry; it does
not extend the server snapshot's lifetime or persist these records in browser
storage. Chart arrays use shallow reactivity to avoid wrapping every record.

Player counts and lists still include the union of retained telemetry and daily
statistics. They now check membership per player rather than sorting all event
rows. Event-only players and imported daily-only players remain included;
profiles without any matching retained records remain excluded. Dates, server
scope, dimensions, search, and pagination keep their previous meaning.

Migration V32 adds a player lookup index and, on PostgreSQL, a covering index
restricted to placed/mined block events. It does not add another aggregation to
the upload transaction. The indexes consume disk space and incur maintenance on
matching writes; they are not cost-free. Before upgrading a busy PostgreSQL
deployment, an operator can build them without blocking ordinary writes:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_telemetry_population
  ON telemetry_events(player_key, server_id, occurred_at, dimension);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_building_read
  ON activity_feed(server_id, occurred_at)
  INCLUDE (metric, dimension, block_x, block_y, block_z, event_value)
  WHERE metric IN ('blocks.placed', 'blocks.mined');
```

Run concurrent index creation outside a transaction and verify `pg_index.indisvalid`
before deploying. The migration recognizes existing indexes by name; it does not
repair an invalid index left by an interrupted manual build.

The web proxy compresses JavaScript, CSS, and statistics JSON when the client
accepts gzip. Login and CSRF JSON routes are not added to JSON compression.
For installations with a custom proxy configuration, merge these changes into
that configuration rather than overwriting map/upload routes.

Regression coverage compares full and partial chart results, checks player
membership across both sources, and exercises desktop/mobile chart switching
through the real HTTP ingestion and login flow. Database query timings should
be reported separately from full page load timings; browser rendering, proxy
latency, cache state, and network bandwidth still affect the latter.

## 中文说明

世界故事馆改为按当前图表取数，切回来时复用尚未过期的两分钟缓存。
未请求的数据列表为空，不代表统计值为零；旧接口不传 `part` 时仍返回全量结果。
玩家查询保持原有“历史事件或每日汇总中存在记录”的规则，不缩短统计时间、不抽样，
也不遗漏仅有事件或仅有导入汇总的玩家。新增索引减少重复扫描，静态脚本和统计结果
通过 gzip 减少传输量。无需更新游戏插件。
