import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { lstat, readFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { HostApi } from "./host-api.mjs";
import { canonicalDirectory, check, contains, isUuid } from "./paths.mjs";

export async function readHostConfig(file, environment = process.env, {maintenance=false}={}) {
  const entry = await lstat(file);
  check(
    entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.nlink === 1 &&
      entry.size <= 65536,
    "Invalid backup host configuration file",
  );
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Host configuration is not valid JSON");
  }
  check(
    value &&
      Object.keys(value).every((key) =>
        [
          "apiUrl",
          "token",
          "allowHttp",
          "root",
          "outputDirectory",
          "serverId",
          "restoreDirectory",
          "backupScope",
        ].includes(key),
      ),
    "Unsupported host configuration field",
  );
  check(
    ["root", "outputDirectory"].every(
      (key) =>
        typeof value[key] === "string" &&
        value[key].length > 0 &&
        value[key].length <= 2048,
    ),
    "Configure explicit local game and backup directories",
  );
  const token = value.token ?? environment.MCM_HOST_TOKEN,
    api = new HostApi({ ...value, token });
  check(value.backupScope === undefined || ['WORLD', 'FULL'].includes(value.backupScope), 'Invalid backup scope');
  const root = await canonicalDirectory(value.root),
    outputDirectory = await canonicalDirectory(value.outputDirectory);
  check(
    isUuid(value.serverId) &&
      !contains(root, outputDirectory) &&
      !contains(root, await realpath(file)),
    "Keep host configuration and backup output outside the game directory",
  );
  let collector;
  try {collector = JSON.parse(
    await readFile(
      path.join(root, "plugins/archive-collector/config/config.json"),
      "utf8",
    ),
  );} catch(error) {if(!maintenance || error.code!=='ENOENT')throw error;}
  check(
    collector?collector.serverId === value.serverId:maintenance,
    "Local collector/world binding differs from this host",
  );
  const stateDirectory = path.join(
    outputDirectory,
    ".mcmanager-host-" + api.hostId,
  );
  check(
    !contains(root, stateDirectory),
    "Host state overlaps the game directory",
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await canonicalDirectory(stateDirectory);
  let restoreDirectory;
  if(value.restoreDirectory!==undefined) {
    check(typeof value.restoreDirectory==='string'&&value.restoreDirectory.length>0&&value.restoreDirectory.length<=2048,'Invalid restore directory');
    restoreDirectory=await canonicalDirectory(value.restoreDirectory);
    check(!contains(root,restoreDirectory)&&!contains(restoreDirectory,root)&&!contains(restoreDirectory,stateDirectory)&&!contains(stateDirectory,restoreDirectory),'Keep restore storage separate from the game and host state');
    check(!contains(restoreDirectory,await realpath(file)),'Keep host credentials outside restore storage');
  }
  return {
    ...value,
    backupScope: value.backupScope ?? 'WORLD',
    token,
    root,
    outputDirectory,
    stateDirectory,
    hostId: api.hostId,
    restoreDirectory,
    maintenance,
    restoreCollectorToken:environment.MCM_RESTORE_COLLECTOR_TOKEN,
  };
}
export async function acquireHostLock(root) {
  check(
    process.platform === "win32",
    "The managed native game host currently requires Windows",
  );
  const name =
    "\\\\.\\pipe\\mcmanager-backup-" +
    createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 40);
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: name, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
