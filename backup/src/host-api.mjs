import { createReadStream } from "node:fs";
import { open,link,unlink } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { check, isUuid } from "./paths.mjs";

export class HostApiError extends Error {
  constructor(status) {
    super(
      status ? `Backup host HTTP ${status}` : "Backup host connection failed",
    );
    this.status = status;
  }
}
export class HostApi {
  #origin;
  #token;
  #uploads = new Set();
  #timeout;
  #uploadTimeout;
  constructor(config, { timeoutMs = 10000, uploadTimeoutMs = 900000 } = {}) {
    let url;
    try {
      url = new URL(config.apiUrl);
    } catch {
      throw new Error("Invalid backup API origin");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    check(
      ["http:", "https:"].includes(url.protocol) &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Choose an API origin without a path, credentials, query or fragment",
    );
    check(
      url.protocol === "https:" || loopback || config.allowHttp === true,
      "Non-loopback HTTP requires explicit allowHttp",
    );
    const match =
      typeof config.token === "string" &&
      config.token.match(/^mcmhost\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/);
    check(
      match && isUuid(match[1]),
      "Use an independent backup host credential",
    );
    this.hostId = match[1];
    this.#origin = url.origin;
    this.#token = config.token;
    this.#timeout = timeoutMs;
    this.#uploadTimeout = uploadTimeoutMs;
  }
  async request(
    route,
    {
      method = "GET",
      body,
      signal,
      headers = {},
      timeoutMs = this.#timeout,
    } = {},
  ) {
    check(
      /^\/(heartbeat|console\/sync|(jobs|restores)\/claim|jobs\/[0-9a-f-]{36}(\/(start|renew|artifact|recover|report|content))?|restores\/[0-9a-f-]{36}(\/(start|renew|report|collector|ready|recover))?)$/.test(
        route,
      ),
      "Invalid host API route",
    );
    let response;
    try {
      response = await fetch(this.#origin + "/api/host/v1" + route, {
        method,
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          Authorization: "Bearer " + this.#token,
        },
        body,
        ...(body && typeof body !== "string" ? { duplex: "half" } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HostApiError(response.status);
      }
      if (response.status === 204) return null;
      if (
        response.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json"
      ) {
        await response.body?.cancel();
        throw new HostApiError(0);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw new HostApiError(0);
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      check(
        result && typeof result === "object" && !Array.isArray(result),
        "Invalid host API response",
      );
      return result;
    } catch (error) {
      if (error instanceof HostApiError) throw error;
      throw new HostApiError(0);
    }
  }
  post(route, value) {
    return this.request(route, { method: "POST", body: JSON.stringify(value) });
  }
  async upload(jobId, runId, attemptId, archive, bytes) {
    check(
      [jobId, runId, attemptId].every(isUuid) && /^[1-9][0-9]*$/.test(bytes),
      "Invalid host upload metadata",
    );
    const controller = new AbortController();
    this.#uploads.add(controller);
    const input = createReadStream(archive);
    try {
      return await this.request(`/jobs/${jobId}/content`, {
        method: "PUT",
        body: input,
        timeoutMs: this.#uploadTimeout,
        signal: controller.signal,
        headers: {
          "X-Host-Run": runId,
          "X-Backup-Attempt": attemptId,
          "Content-Type": "application/octet-stream",
          "Content-Length": bytes,
        },
      });
    } finally {
      input.destroy();
      this.#uploads.delete(controller);
    }
  }
  cancelUploads() {
    for (const controller of this.#uploads) controller.abort();
  }
  async downloadRestore(job,runId,attemptId,file,signal) {
    check([job.id,runId,attemptId].every(isUuid)&&/^[1-9][0-9]{0,10}$/.test(job.archiveBytes)&&BigInt(job.archiveBytes)<=17179869184n&&/^[a-f0-9]{64}$/.test(job.archiveSha256),'Invalid restore download identity');
    const abort=new AbortController();this.#uploads.add(abort);let handle;
    try {
      const response=await fetch(this.#origin+'/api/host/v1/restores/'+job.id+'/content',{redirect:'manual',headers:{Authorization:'Bearer '+this.#token,'X-Host-Run':runId,'X-Restore-Attempt':attemptId},signal:AbortSignal.any([abort.signal,...(signal?[signal]:[]),AbortSignal.timeout(this.#uploadTimeout)])});
      if(response.status!==200){await response.body?.cancel();throw new HostApiError(response.status);}
      if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/octet-stream'||response.headers.get('content-length')!==job.archiveBytes||response.headers.get('x-archive-sha256')!==job.archiveSha256){await response.body?.cancel();throw new HostApiError(0);}
      const temporary=file+'.'+randomUUID()+'.partial';handle=await open(temporary,'wx',0o600);const hash=createHash('sha256');let count=0n;
      for await(const chunk of response.body){count+=BigInt(chunk.length);check(count<=BigInt(job.archiveBytes),'Restore download exceeds expected length');hash.update(chunk);await handle.writeFile(chunk);}
      check(count.toString()===job.archiveBytes&&hash.digest('hex')===job.archiveSha256,'Restore download checksum failed');await handle.sync();await handle.close();handle=undefined;
      await link(temporary,file);await unlink(temporary);
    } catch(error){if(error instanceof HostApiError)throw error;throw new HostApiError(0);}
    finally {await handle?.close();this.#uploads.delete(abort);}
  }
}
