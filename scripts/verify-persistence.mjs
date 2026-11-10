// Run after backend/mvnw verify. Uses a separate file database and random credentials.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const qaPath = path.join(root, ".tools", `persistence-${randomUUID()}`);
mkdirSync(qaPath, { recursive: true });
const java = process.env.JAVA_HOME
  ? path.join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    )
  : "java";
const adminPassword = randomBytes(24).toString("base64");
const port = process.env.MCM_QA_PORT ?? "18081";
const base = `http://127.0.0.1:${port}`;
let child;
let log = "";
let cookies = new Map();
let csrf;

async function request(endpoint, options = {}) {
  const headers = {
    Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    ...options.headers,
  };
  const response = await fetch(base + endpoint, { ...options, headers });
  for (const cookie of response.headers.getSetCookie()) {
    const [name, value] = cookie.split(";")[0].split("=");
    cookies.set(name, value);
  }
  return response;
}

async function start() {
  cookies = new Map();
  log = "";
  child = spawn(
    java,
    ["-jar", path.join(root, "backend/target/mcmanager-archive-0.1.0.jar")],
    {
      cwd: qaPath,
      windowsHide: true,
      env: {
        ...process.env,
        MCM_PORT: port,
        MCM_BIND_ADDRESS: "127.0.0.1",
        MCM_ADMIN_USERNAME: "admin",
        MCM_ADMIN_PASSWORD: adminPassword,
        MCM_DB_URL:
          "jdbc:h2:file:./archive;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;WRITE_DELAY=0",
        MCM_DB_USER: "sa",
        MCM_DB_PASSWORD: "",
        MCM_COOKIE_SECURE: "false",
      },
    },
  );
  child.stdout.on("data", (data) => {
    log += data;
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Application exited: ${log}`);
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      /* Wait until listening. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Application startup timed out: ${log}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

async function login() {
  csrf = await (await request("/api/auth/csrf")).json();
  const result = await request("/api/auth/login", {
    method: "POST",
    headers: { [csrf.headerName]: csrf.token },
    body: new URLSearchParams({ username: "admin", password: adminPassword }),
  });
  if (result.status !== 204) throw new Error(`Login failed: ${result.status}`);
  csrf = await (await request("/api/auth/csrf")).json();
}

try {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(Number(port), "127.0.0.1", () => probe.close(resolve));
  });
  await start();
  await login();
  const created = await request("/api/servers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [csrf.headerName]: csrf.token,
    },
    body: JSON.stringify({
      name: "独立重启持久化验收",
      description: "QA data in .tools only",
      startDate: "2026-10-26",
    }),
  });
  if (created.status !== 201)
    throw new Error(`Create failed: ${created.status}`);
  const saved = await created.json();
  await stop();
  await start();
  await login();
  const response = await request(`/api/servers/${saved.id}`);
  const restored = await response.json();
  if (
    response.status !== 200 ||
    restored.name !== saved.name ||
    restored.createdAt !== saved.createdAt
  ) {
    throw new Error(
      `Archive did not survive restart: ${JSON.stringify({ status: response.status, saved, restored })}`,
    );
  }
  console.log(
    JSON.stringify({
      persistedAfterRestart: true,
      id: saved.id,
      qaDirectory: qaPath,
    }),
  );
} finally {
  await stop();
}
