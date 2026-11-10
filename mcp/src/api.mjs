export function configuration(env = process.env) {
  let url;
  try { url = new URL(env.MCM_MCP_API_URL ?? 'http://127.0.0.1:8080'); }
  catch { throw new Error('MCM_MCP_API_URL must be a valid backend origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('MCM_MCP_API_URL must be an HTTP(S) origin without credentials, path or query');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && env.MCM_MCP_ALLOW_HTTP !== 'true')
    throw new Error('Use HTTPS, or explicitly set MCM_MCP_ALLOW_HTTP=true for a trusted private network');
  const token = env.MCM_AGENT_TOKEN;
  if (typeof token !== 'string' || !/^mcmagent\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('MCM_AGENT_TOKEN must be an independently issued Agent token');
  return Object.freeze({ origin: url.origin, token });
}

export class ApiError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

const messages = {
  INVALID_REQUEST: '参数不符合要求，请核对服务器、玩家、日期或验证码。',
  INVALID_DATE_RANGE: '开始日期不能晚于结束日期。',
  AGENT_TOKEN_INVALID: '助手连接密钥无效或已停用，请在网页的“AI 助手”中检查配置。',
  PERMISSION_DENIED: '当前助手没有这台服务器的所需权限，请核对 list_servers 返回的授权。',
  NOT_FOUND: '没有找到这条记录，或它不属于当前助手可访问的范围。',
  CONFLICT: '请求与已有记录冲突，请先查询现有状态；不要更换编号盲目重试。',
  RATE_LIMITED: '请求太频繁，请稍后再试。',
  BACKEND_UNREACHABLE: '无法连接平台，请检查地址、网络和服务状态。写入请求可能已经被接收。',
  BACKEND_TIMEOUT: '平台响应超时，不能据此判断请求没有执行。',
  REQUEST_CANCELLED: '调用已取消；已提交的请求不一定随之撤销。',
  BACKEND_ERROR: '平台暂时无法完成请求，请稍后查询原请求的状态。',
  INVALID_BACKEND_RESPONSE: '平台返回了无法识别的数据，请检查地址或代理配置。',
  BACKEND_RESPONSE_TOO_LARGE: '结果太大，请缩小日期范围或分页数量。',
};
export function errorDetails(error) {
  const code = error instanceof ApiError ? error.code : 'TOOL_FAILED';
  return {
    error: code, status: error instanceof ApiError ? error.status : null,
    message: messages[code] ?? '工具暂时无法完成请求，请检查连接配置。',
    ...(error instanceof ApiError && Number.isInteger(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

export class ArchiveApi {
  constructor(config) { this.config = config; }
  async request(path, { query = {}, body, signal, timeout = 35_000 } = {}) {
    // Paths are constructed internally. Never accept an arbitrary URL from tool arguments.
    if (!path.startsWith('/api/agent/') || path.includes('?') || path.includes('#')) throw new ApiError('INVALID_API_PATH');
    const url = new URL(path, this.config.origin);
    if (url.origin !== this.config.origin || !url.pathname.startsWith('/api/agent/')) throw new ApiError('INVALID_API_PATH');
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const deadline = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const interrupted = () => signal?.aborted ? new ApiError('REQUEST_CANCELLED') : deadline.aborted ? new ApiError('BACKEND_TIMEOUT') : null;
    let response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch { throw interrupted() ?? new ApiError('BACKEND_UNREACHABLE'); }
    // Do not forward server HTML, proxy errors, stack traces or credentials into model context.
    if (!response.ok) {
      await response.body?.cancel();
      const error = new ApiError(({ 400: 'INVALID_REQUEST', 401: 'AGENT_TOKEN_INVALID', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 408: 'BACKEND_TIMEOUT', 409: 'CONFLICT', 410: 'NOT_FOUND', 429: 'RATE_LIMITED', 504: 'BACKEND_TIMEOUT' })[response.status] ?? 'BACKEND_ERROR', response.status);
      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429 && /^\d{1,4}$/.test(retryAfter ?? '') && Number(retryAfter) <= 3600) error.retryAfterSeconds = Number(retryAfter);
      throw error;
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel(); throw new ApiError('INVALID_BACKEND_RESPONSE');
    }
    if (!response.body) throw new ApiError('INVALID_BACKEND_RESPONSE');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ApiError('BACKEND_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data === null || typeof data !== 'object') throw new ApiError('INVALID_BACKEND_RESPONSE');
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw interrupted() ?? new ApiError('INVALID_BACKEND_RESPONSE');
    } finally { reader.releaseLock(); }
  }
}
