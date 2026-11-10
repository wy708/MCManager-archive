# 开发与验证

## 常用检查

需要 JDK 21、Node.js 24、Python 3。前端浏览器测试需要 Chromium。

```sh
npm ci --prefix backup --ignore-scripts
cd backend
sh mvnw -B -ntp test
cd ../frontend
npm ci
npm run build
npx playwright install chromium
npx playwright test
cd ../mcp
npm ci --ignore-scripts
npm test
cd ../backup
npm ci --ignore-scripts
npm test
cd ..
node --test integrations/dsh/game-ai.test.mjs
python3 scripts/check-public.py
```

Windows 使用 `mvnw.cmd`。备份执行端包含 Windows 进程/文件系统验证，应在 Windows 上执行完整测试。原生核心测试需要 MSVC 与 xmake，见 [采集器](../collector/README.md)。

Playwright 启动独立内存 H2 和开发服务器，使用虚构管理员与测试数据；测试密码不是部署凭据。不要将测试的 API 地址改到生产环境。三维转换集成测试需要先构建 `scene/` 运行库，并设置 `MCM_SCENE_RUNNER`、`MCM_SCENE_JAVA`、`MCM_SCENE_DIR`。

## 此预发布检查范围

- Web 构建和类型检查通过。
- 整理后的源码后端测试 159 项：156 项通过、3 项按环境条件跳过，无失败；先安装 backup 模块依赖再执行。
- 43 项浏览器检查：登录权限、统计、聊天、备份任务/恢复、工程与模型操作、14 个页面及桌面/360/390/768 宽度。一次完整运行 42 项通过后修复了桌面模型测试坐标，再对两种模型视口和演示数据页面复测通过。
- MCP 单元测试 25 项通过。
- Windows 备份执行端测试 39 项通过。
- DSH 桥接测试 5 项通过。
- 初始化配置测试 3 项通过，覆盖随机凭据、拒绝覆盖和地址校验。
- 文档截图由虚构协议数据驱动的实际网页生成，不使用生产数据。

测试运行结果属于对应版本和环境，不意味着任意游戏更新、任意资源包或任意部署都已验证。没有进行大规模玩家压力测试；DSH 实际群会话和游戏问答需要部署者联调。历史开发过程的个人日志、地址与运行目录不属于公开文档。

## CI

`.github/workflows/ci.yml` 提供 API/Web/MCP/桥接及 Windows 备份检查。配置提交不代表 GitHub 已执行；以托管平台实际运行结果为准。原生游戏联调和完整三维资源构建不在普通 PR CI 中运行。
