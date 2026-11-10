import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '// MCManager game AI bridge v1';
export function patchBridge(source) {
  if (source.includes(MARKER)) return source;
  let text = source.replace(/\r\n/g, '\n');
  const once = (from, to) => {
    if (text.split(from).length !== 2) throw new Error('桥接版本与补丁不匹配，未修改文件：' + from.slice(0, 90));
    text = text.replace(from, to);
  };
  once("import fs from 'node:fs';", `${MARKER}\nimport { loadGameAi } from './mcmanager-game-ai.mjs';\nimport fs from 'node:fs';`);
  once('async function main() {', 'async function main() {\n  let gameAi = null;');
  once("function redactKnownTokensOnly(text) {\n    let s = String(text ?? '');",
    "function redactKnownTokensOnly(text) {\n    let s = String(text ?? '').replace(/mcmgame_[a-f0-9]{48}/gi, '***');");
  // Console auth, Host/Origin checks, paused/mode gates remain in place.
  // A game capability is accepted ONLY on this one send route, never on
  // QQ sends, memory reads or admin routes. The handler binds the exact key.
  once('if (hasToken && !isLiveAgentToken(agentToken)) {',
    `if (hasToken && !isLiveAgentToken(agentToken) && !(req.method === 'POST' && url.pathname === '/api/socialV2/send-message' && gameAi?.acceptsToken(agentToken))) {`);
  once(`if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();`,
    `if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key.startsWith('game:')) {
            try {
              if (!gameAi) { sendJson({ ok: false, error: '游戏 AI 未启用' }, 403); return; }
              sendJson(await gameAi.reply(key, req.headers['x-agent-token'], body));
            } catch (e) { sendJson({ ok: false, error: e.statusCode ? e.message : '游戏回答写入失败，请重试同一回答' }, e.statusCode || 503); }
            return;
          }`);
  once("let content = [{ type: 'text', text: withSlangContext(promptText) }];\n    if (Array.isArray(opts.media)",
    "promptText += gameAi?.prompt(key) || '';\n    let content = [{ type: 'text', text: withSlangContext(promptText) }];\n    if (Array.isArray(opts.media)");
  once('while (!aborted && Date.now() - start < timeoutMs) {',
    'while (!aborted && Date.now() - start < timeoutMs && !gameAi?.hasPending(key)) {');
  once('} else while (Date.now() - start < timeoutMs && !aborted) {',
    '} else while (Date.now() - start < timeoutMs && !aborted && !gameAi?.hasPending(key)) {');
  once('while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {',
    'while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted && !gameAi?.hasPending(key)) {');
  once("purpose: replyWait ? 'reply' : 'messages',\n            arrived,",
    "purpose: replyWait ? 'reply' : 'messages',\n            ...(gameAi?.hasPending(key) ? { gameAiContext: gameAi.prompt(key), gameQuestionPending: true } : {}),\n            arrived,");
  once('canSleepNow: !preSleepBlocked,', 'canSleepNow: !preSleepBlocked && !gameAi?.hasPending(key),');
  once('hint: preSleepBlocked\n                ?', "hint: gameAi?.hasPending(key) ? '先处理 gameAiContext 中的游戏提问，使用其中的专属回复目标，不要继续等待或发到 QQ。' : preSleepBlocked\n                ?");
  once('  startConsoleServer();\n  startPrivateProactiveLoop();', `  try {
    gameAi = await loadGameAi(ROOT, {
      allowed: key => dshReady && currentMode === 'reserved2' && !socialV2.paused && cfg.socialV2?.enabled !== false
        && v2SessionAllowed(key) && v2ToolEnabled('sendMessage') && !shouldBlockSilentReply(key),
      wake: async key => {
        if (activeWaits.has(key) || isConversationBusyV2(key, getSocialV2State(key))) return false;
        await sendWakePromptV2(key, 'gameAi');
        return true;
      },
      sensitive: text => SENSITIVE_RE.test(text), log
    });
    gameAi?.start();
    if (gameAi) log('MCManager 游戏 /ai 本机接入已启用：沿用关联群会话与记忆，游戏回答只回提问玩家');
  } catch { log('MCManager 游戏 AI 配置无效，游戏入口未启用；QQ 桥接继续运行'); }
  startConsoleServer();
  startPrivateProactiveLoop();`);
  return text;
}

export async function installBridge(root) {
  root = path.resolve(root);
  const target = path.join(root, 'src', 'bridge.js');
  const source = await fs.readFile(target, 'utf8');
  const updated = patchBridge(source); // validate every anchor before any write
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, 'mcmanager-ai-backups', timestamp);
  await fs.mkdir(backup, { recursive: true });
  await fs.copyFile(target, path.join(backup, 'bridge.js'));
  const moduleTarget = path.join(root, 'src', 'mcmanager-game-ai.mjs');
  await fs.copyFile(moduleTarget, path.join(backup, 'mcmanager-game-ai.mjs')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await fs.copyFile(new URL('./game-ai.mjs', import.meta.url), moduleTarget);
  const temporary = target + '.mcmanager-writing';
  await fs.writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, target);
  return backup;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node patch-bridge.mjs QQ桥接目录');
  console.log('桥接补丁已安装，原文件备份：' + await installBridge(process.argv[2]));
}
