# Interface languages / 界面语言

MCManager supports Simplified Chinese and English in the web workspace, login screen, public project pages and map navigation controls.

[Desktop preview](images/dashboard-en-desktop.jpg) · [Mobile preview](images/dashboard-en-mobile.jpg) (synthetic data)

## Choose a language

Use the language selector on the login page or in the workspace header. Public project and world-map viewers also have their own selector. The choice is saved in this browser. Switching languages reloads the current page while preserving its route, query filters and fragment; save any unfinished form first.

A link can set `?lang=en` or `?lang=zh-CN` (use `&lang=...` if the URL already has query parameters). A valid URL language takes priority over the saved preference. With no preference, Chinese browser locales use Simplified Chinese and other browser locales use English. When storage is disabled, an explicit language remains in the current URL.

Dates, number formatting, chart labels and built-in game names follow the interface language. Statistical day boundaries and backup schedules keep their configured time zone; choosing English does not change them.

Player messages, names, project titles, administrator notes and raw game logs remain as recorded. Platform-owned diagnostic messages have an English lookup; unknown or third-party errors remain in their original form. Native browser controls, including the date picker, may follow the browser or operating-system language.

## Performance and scope

Translations and game-name catalogs are bundled locally. There is no translation API, additional polling or game-server collection. Existing lazy chart and scene loading is preserved. This change localizes the web interface; it does not translate the collector console, MCP tool descriptions or all developer documentation.

## Contributing translations

- UI messages: `frontend/src/locales/zh-CN.json` and `en.json`.
- Platform diagnostic lookup: `frontend/src/locales/server-messages.json`. Do not apply this lookup to player-generated content.
- Preserve interpolation placeholders such as `{0}` and ECharts tokens such as `{b}` exactly.
- English game names: `frontend/src/bedrock-names.en.json`. Regenerate with `node scripts/generate-english-game-names.mjs` after installing the collector QA dependencies; the script matches the registry version in the existing Chinese catalog and uses readable ID fallbacks for legacy entries.
- Standalone map controls: `map/viewer_language.js`, `coordinate_jump.js` and `layer_controls.js`.
- Run `node --test frontend/test/*.test.mjs` and `npm run build --prefix frontend`.

## 中文说明

在登录页、后台顶部、公开工程页或地图坐标面板选择语言。浏览器会记住选择；切换时会重新加载当前地址，请先保存未提交的表单。链接可使用 `?lang=en` 或 `?lang=zh-CN` 指定语言。

玩家聊天、名称、工程名、备注和原始游戏日志保留原文；统计日界线与备份时区不变。语言包在本地加载，不增加游戏服务器采集或定时请求。
