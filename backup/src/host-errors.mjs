// Never echo arbitrary exception messages: they can contain credentials or HTTP bodies.
const messages = new Map([
  ['Server is running; a stopped-server snapshot requires a clean stop first', '该游戏目录仍有服务端进程。请在游戏控制台输入 stop，等待退出后再启动执行端。'],
  ['Cannot prove whether a BDS process belongs to this server', '检测到游戏进程，但当前权限无法读取它的目录。请以与游戏服相同的 Windows 用户和权限运行。'],
  ['Host configuration is not valid JSON', '执行端配置无法读取或格式错误，请重新运行 02-configure.cmd。'],
  ['Local collector/world binding differs from this host', '采集插件与执行端绑定的档案不同，请重新运行 02-configure.cmd。'],
  ['Use an independent backup host credential', '执行端凭据格式不正确，请重新运行 02-configure.cmd。'],
  ['Configure explicit local game and backup directories', '游戏或备份目录未配置，请重新运行 02-configure.cmd。'],
  ['Keep host configuration and backup output outside the game directory', '执行端配置和备份目录必须放在游戏目录之外。'],
  ['Expected a real directory, not a link', '配置的目录不是实际文件夹，或使用了目录链接。请检查游戏和备份路径。'],
  ['Unsupported host configuration field', '执行端配置包含不支持的字段，请重新运行 02-configure.cmd。'],
  ['The collector backup control did not become ready', '游戏未完成启动，或采集插件控制通道未就绪。请查看上方游戏日志。'],
  ['Native backup control did not confirm the request', '游戏没有回应控制请求，请查看上方游戏日志，确认没有停在认证或加载阶段。'],
  ['The managed game exited', '游戏进程已退出，请查看上方游戏日志中的停服原因。'],
  ['Game exited during startup', '游戏在启动过程中退出，请查看上方游戏日志中的原因。'],
  ['Console binding mismatch', '平台返回的执行端绑定不匹配，请检查服务器档案和接入配置。'],
]);
export function hostErrorMessage(error, stage = '') {
  if (messages.has(error?.message)) return messages.get(error.message);
  if (error?.status === 401 || error?.status === 403) return '平台拒绝了执行端凭据，请确认凭据没有被撤销。';
  if (error?.status === 409) return '平台检测到执行端会话冲突，请确认没有另一份执行端正在连接。';
  if (error?.status === 0) return '无法连接平台或无法验证平台响应，请检查 HTTPS 网络连接和系统时间。';
  if (error?.code === 'EADDRINUSE') return '该游戏目录已有执行端占用控制通道，请退出旧执行端窗口后重试。';
  if (['EACCES','EPERM'].includes(error?.code)) return '当前 Windows 用户没有访问文件或控制通道的权限，请使用与游戏服相同的运行权限。';
  if (error?.code === 'ENOENT') return stage === '检查游戏进程' ? '找不到 Windows PowerShell，无法确认游戏是否已停止。' : '找不到配置中的文件或目录，请检查目录是否移动，并重新运行 02-configure.cmd。';
  if (stage === '检查游戏进程' && error?.killed) return 'Windows PowerShell 进程检查超过 15 秒，请检查系统负载及 PowerShell 是否能正常运行。';
  if (stage === '检查游戏进程') return 'Windows PowerShell 进程检查失败，请运行 07-diagnose.cmd 查看检查结果。';
  const code = /^[A-Z][A-Z0-9_]{1,50}$/.test(String(error?.code)) ? '（'+error.code+'）' : '';
  return '此步骤未完成'+code+'，请运行 07-diagnose.cmd 并提供检查结果。';
}
