// Exercises an isolated QA deployment. Creates labelled archives; does not emulate a real game.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("MCM_") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const base = process.env.MCM_QA_BASE_URL ?? "http://127.0.0.1:18088";
const cookies = new Map();
let csrf;
async function request(endpoint, options = {}) {
  const headers = {
    Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    ...options.headers,
  };
  const response = await fetch(base + endpoint, { ...options, headers });
  for (const cookie of response.headers.getSetCookie()) {
    const index = cookie.indexOf("=");
    cookies.set(cookie.slice(0, index), cookie.slice(index + 1).split(";")[0]);
  }
  return response;
}
async function api(endpoint, data, method = "POST") {
  const options =
    data === undefined && method === "GET"
      ? {}
      : {
          method,
          headers: {
            [csrf.headerName]: csrf.token,
            "Content-Type": "application/json",
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        };
  const response = await request(endpoint, options);
  assert.ok(response.ok, `${endpoint} returned ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}
const html = await fetch(base);
assert.equal(html.status, 200);
assert.ok(
  html.headers.get("content-security-policy")?.includes("default-src 'self'"),
);
for (const asset of [
  ...(await html.text()).matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g),
])
  assert.equal((await fetch(base + asset[1])).status, 200);
csrf = await (await request("/api/auth/csrf")).json();
const login = await request("/api/auth/login", {
  method: "POST",
  headers: { [csrf.headerName]: csrf.token },
  body: new URLSearchParams({
    username: env.MCM_ADMIN_USERNAME ?? "admin",
    password: env.MCM_ADMIN_PASSWORD,
  }),
});
assert.equal(login.status, 204);
csrf = await (await request("/api/auth/csrf")).json();
if (process.argv.includes("--check-existing")) {
  const evidencePath = path.join(root, ".tools/telemetry-http-evidence.json");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const summary = await api(
    `/api/statistics/summary?playerKey=${encodeURIComponent(evidence.playerKey)}`,
    undefined,
    "GET",
  );
  assert.equal(
    summary.metrics.find((metric) => metric.key === "blocks.mined").value,
    evidence.minedBlocks,
  );
  assert.equal(
    summary.metrics.find((metric) => metric.key === "online.millis").value,
    evidence.onlineMillis,
  );
  const profile = await api(
    `/api/players/${encodeURIComponent(evidence.playerKey)}`,
    undefined,
    "GET",
  );
  assert.equal(profile.servers.length, 2);
  evidence.persistedAfterContainerRestart = true;
  evidence.recheckedAt = new Date().toISOString();
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      persistedAfterContainerRestart: true,
      playerKey: evidence.playerKey,
    }),
  );
  process.exit(0);
}
const tag = randomUUID().slice(0, 8);
const date = (millis) =>
  new Date(millis).toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" });
const first = await api("/api/servers", {
  name: `QA · 采集链路 ${tag} A`,
  description: "HTTP contract QA, not real gameplay",
  startDate: date(Date.now() - 86_400_000),
});
const second = await api("/api/servers", {
  name: `QA · 采集链路 ${tag} B`,
  description: "HTTP contract QA, not real gameplay",
  startDate: date(Date.now() - 86_400_000),
});
const firstCredential = await api(
  `/api/servers/${first.id}/collector-credential`,
  {},
);
const secondCredential = await api(
  `/api/servers/${second.id}/collector-credential`,
  {},
);
const identity = (
  (BigInt("0x" + randomBytes(8).toString("hex")) % 9_000_000_000_000_000_000n) +
  1n
).toString();
const player = { identityType: "XUID", identity, name: `QA-${tag}` };
const startedAt = new Date(Date.now() - 20_000).toISOString();
const sessionId = randomUUID();
const checkpoint = (sequence, onlineMillis, ended) => ({
  eventId: randomUUID(),
  kind: "SESSION",
  at: new Date(Date.parse(startedAt) + onlineMillis).toISOString(),
  player,
  dimension: "minecraft:overworld",
  sessionId,
  startedAt,
  sequence,
  onlineMillis,
  ended,
});
const counter = (metric, value, subject) => ({
  eventId: randomUUID(),
  kind: "COUNTER",
  at: startedAt,
  player,
  dimension: "minecraft:overworld",
  metric,
  value,
  ...(subject ? { subject } : {}),
});
const caps = [
  "online.millis",
  "blocks.mined",
  "experience.gained",
  "level.max",
].map((metric) => ({
  metric,
  state: "ACTIVE",
  quality: "EXACT",
  algorithmVersion: "http-qa-v1",
  dimensionAware: true,
}));
const batch = (events) => ({
  protocolVersion: 1,
  batchId: randomUUID(),
  reportedAt: new Date().toISOString(),
  collector: {
    version: "http-contract-qa",
    bdsVersion: "not-a-game",
    leviLaminaVersion: "not-a-plugin",
    bootId: randomUUID(),
    pendingEvents: 0,
  },
  capabilities: caps,
  events,
});
async function ingest(credential, body) {
  return fetch(base + "/api/ingest/v1/batches", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
try {
  const payload = batch([
    checkpoint(0, 0, false),
    counter("blocks.mined", 9, "minecraft:oak_log"),
    counter("experience.gained", 30),
    counter("level.max", 15),
    checkpoint(1, 10000, true),
  ]);
  const firstUpload = await ingest(firstCredential, payload);
  assert.equal(firstUpload.status, 200);
  assert.equal((await firstUpload.json()).acceptedEvents, 5);
  const replay = await ingest(firstCredential, payload);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicateBatch, true);
  const next = counter("blocks.mined", 2, "minecraft:diamond_ore");
  next.player = { ...player, name: `${player.name}-renamed` };
  assert.equal(
    (await ingest(secondCredential, batch([next, counter("level.max", 8)])))
      .status,
    200,
  );
  const summary = await api(
    `/api/statistics/summary?playerKey=xuid:${identity}`,
    undefined,
    "GET",
  );
  const metric = (key) =>
    summary.metrics.find((entry) => entry.key === key).value;
  assert.equal(summary.playerCount, 1);
  assert.equal(metric("blocks.mined"), "11");
  assert.equal(metric("online.millis"), "10000");
  assert.equal(metric("experience.gained"), "30");
  assert.equal(metric("level.max"), "15");
  assert.equal(summary.woodBlocks, "9");
  assert.equal(summary.oreBlocks, "2");
  await api(`/api/servers/${first.id}/archive`, { endDate: date(Date.now()) });
  const afterSeal = await api(
    `/api/statistics/summary?playerKey=xuid:${identity}`,
    undefined,
    "GET",
  );
  assert.equal(
    afterSeal.metrics.find((entry) => entry.key === "blocks.mined").value,
    "11",
  );
  const profile = await api(`/api/players/xuid:${identity}`, undefined, "GET");
  assert.equal(profile.servers.length, 2);
  assert.equal(profile.names.length, 2);
  mkdirSync(path.join(root, ".tools"), { recursive: true });
  const evidence = {
    verifiedAt: new Date().toISOString(),
    base,
    servers: [first.id, second.id],
    playerKey: `xuid:${identity}`,
    playerCount: 1,
    minedBlocks: "11",
    onlineMillis: "10000",
    highestLevel: "15",
    batchReplayDeduplicated: true,
    archivedHistoryRetained: true,
    realGameplay: false,
  };
  writeFileSync(
    path.join(root, ".tools/telemetry-http-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await api(
    `/api/servers/${first.id}/collector-credential`,
    undefined,
    "DELETE",
  );
  await api(
    `/api/servers/${second.id}/collector-credential`,
    undefined,
    "DELETE",
  );
}
