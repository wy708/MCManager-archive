import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { ArchiveApi, ApiError, configuration, errorDetails } from '../src/api.mjs';

const token = `mcmagent.11111111-1111-4111-8111-111111111111.${'a'.repeat(43)}`;
async function fixture(handler, action) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await action(new ArchiveApi(configuration({ MCM_MCP_API_URL: origin, MCM_AGENT_TOKEN: token })), origin); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const code = expected => error => error instanceof ApiError && error.code === expected;

test('configuration restricts endpoint origins and independent Agent tokens', () => {
  assert.equal(configuration({ MCM_AGENT_TOKEN: token }).origin, 'http://127.0.0.1:8080');
  for (const value of ['file:///tmp/keys', 'https://user:secret@example.com', 'http://example.com', 'https://example.com/path', 'https://example.com?secret=x'])
    assert.throws(() => configuration({ MCM_AGENT_TOKEN: token, MCM_MCP_API_URL: value }));
  assert.equal(configuration({ MCM_AGENT_TOKEN: token, MCM_MCP_API_URL: 'http://192.0.2.10:8080', MCM_MCP_ALLOW_HTTP: 'true' }).origin, 'http://192.0.2.10:8080');
  assert.throws(() => configuration({ MCM_AGENT_TOKEN: 'admin-password' }));
  assert.throws(() => configuration({ MCM_AGENT_TOKEN: `${token}\r\nInjected: yes` }));
});
test('request preserves large integer strings and sends only scoped Bearer requests', async () => {
  await fixture((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); assert.equal(req.headers.cookie, undefined);
    assert.equal(req.url, '/api/agent/servers?after=9223372036854775807');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"value":"9007199254740993","missing":null}');
  }, async api => {
    assert.deepEqual(await api.request('/api/agent/servers', { query: { after: '9223372036854775807' } }), { value: '9007199254740993', missing: null });
    await assert.rejects(api.request('/api/servers'), code('INVALID_API_PATH'));
    await assert.rejects(api.request('/api/agent/../../admin'), code('INVALID_API_PATH'));
    await assert.rejects(api.request('/api/agent/%2e%2e/%2e%2e/admin'), code('INVALID_API_PATH'));
  });
});
test('redirects never forward credentials to another origin', async () => {
  let leakedRequests = 0;
  await fixture((req, res) => { leakedRequests++; res.end('{}'); }, async (_, sink) => {
    await fixture((req, res) => { res.writeHead(302, { Location: sink }); res.end(); }, async api => {
      await assert.rejects(api.request('/api/agent/servers'), code('BACKEND_UNREACHABLE'));
    });
  });
  assert.equal(leakedRequests, 0);
});
test('HTTP errors redact bodies and retain structured status codes', async () => {
  for (const [status, expected] of [[401, 'AGENT_TOKEN_INVALID'], [403, 'PERMISSION_DENIED'], [408, 'BACKEND_TIMEOUT'], [409, 'CONFLICT'], [429, 'RATE_LIMITED'], [503, 'BACKEND_ERROR'], [504, 'BACKEND_TIMEOUT']])
    await fixture((req, res) => { res.writeHead(status); res.end(`private diagnostic ${token}`); }, async api => {
      await assert.rejects(api.request('/api/agent/servers'), error => code(expected)(error) && error.status === status && !error.message.includes(token));
    });
});
test('HTML, malformed JSON and oversized success bodies are rejected', async () => {
  for (const [type, body, expected] of [['text/html', '<html>login</html>', 'INVALID_BACKEND_RESPONSE'], ['application/json', '{', 'INVALID_BACKEND_RESPONSE'], ['application/json', ' '.repeat(2 * 1024 * 1024 + 1), 'BACKEND_RESPONSE_TOO_LARGE']])
    await fixture((req, res) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); }, async api => {
      await assert.rejects(api.request('/api/agent/servers'), code(expected));
    });
});
test('requests have finite timeouts and respect MCP cancellation', async () => {
  await fixture(() => {}, async api => {
    await assert.rejects(api.request('/api/agent/servers', { timeout: 30 }), code('BACKEND_TIMEOUT'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.request('/api/agent/servers', { signal: controller.signal }), code('REQUEST_CANCELLED'));
  });
});

test('timeouts and cancellation retain their meaning after response headers', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    await fixture((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
      if (cancel) controller.abort();
    }, async api => {
      await assert.rejects(api.request('/api/agent/servers', { timeout: 150, signal: controller.signal }), code(cancel ? 'REQUEST_CANCELLED' : 'BACKEND_TIMEOUT'));
    });
  }
});

test('rate-limit advice is bounded and error details never contain server diagnostics', async () => {
  for (const [header, expected] of [['12', 12], ['9999', undefined], ['private-token', undefined]]) {
    await fixture((req, res) => { res.writeHead(429, { 'Retry-After': header }); res.end(token); }, async api => {
      await assert.rejects(api.request('/api/agent/servers'), error => {
        const details = errorDetails(error);
        assert.equal(details.retryAfterSeconds, expected);
        assert.equal(details.error, 'RATE_LIMITED');
        assert.ok(details.message.includes('稍后'));
        assert.ok(!JSON.stringify(details).includes(token));
        return true;
      });
    });
  }
  assert.ok(!JSON.stringify(errorDetails(new Error(token))).includes(token));
});

test('JSON primitives are not accepted as API records', async () => {
  for (const body of ['null', 'true', '42', '"text"']) {
    await fixture((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); }, async api => {
      await assert.rejects(api.request('/api/agent/servers'), code('INVALID_BACKEND_RESPONSE'));
    });
  }
});
