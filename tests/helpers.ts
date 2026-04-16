import { type ChildProcess, spawn, fork } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..");

export interface WranglerHandle {
  port: number;
  stop: () => Promise<void>;
  logs: () => string;
}

/**
 * Spawn wrangler dev as a child process and wait until the worker responds
 * on /health. Streams wrangler output to stdout prefixed with [wrangler].
 */
export async function spawnWrangler(opts: {
  port: number;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}): Promise<WranglerHandle> {
  const { port, env = {}, readyTimeoutMs = 240_000 } = opts;
  const logChunks: string[] = [];

  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // new process group so we can kill children
    },
  );

  const onData = (prefix: string) => (chunk: Buffer) => {
    const text = chunk.toString();
    logChunks.push(text);
    process.stdout.write(`[wrangler:${port}${prefix}] ${text}`);
  };
  child.stdout?.on("data", onData(""));
  child.stderr?.on("data", onData(":err"));

  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  const ei = () => exitInfo as { code: number | null; signal: NodeJS.Signals | null } | null;

  // Wait for /health to respond 200.
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < readyTimeoutMs) {
    if (exited) {
      const info = ei();
      throw new Error(
        `wrangler exited before ready (code=${info?.code}, signal=${info?.signal}); logs:\n${logChunks.join("")}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = await res.text();
        if (body.includes("ok")) break;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000);
  }
  if (Date.now() - start >= readyTimeoutMs) {
    await stop(child);
    throw new Error(
      `wrangler never became ready within ${readyTimeoutMs}ms; last error: ${String(lastErr)}\nlogs:\n${logChunks.join("")}`,
    );
  }

  return {
    port,
    logs: () => logChunks.join(""),
    stop: () => stop(child),
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Kill the whole process group so wrangler's subprocesses die too.
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // fallback to direct kill
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const exitP = new Promise<void>((r) => child.once("exit", () => r()));
  const timed = await Promise.race([
    exitP.then(() => "exited" as const),
    sleep(10_000).then(() => "timeout" as const),
  ]);
  if (timed === "timeout") {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
    await exitP;
  }
}

export interface ProxyHandle {
  socketPath: string;
  stop: () => Promise<void>;
}

/**
 * Start the Docker privileged proxy on a unique socket path. Returns once
 * the socket is accepting connections.
 */
export async function startDockerProxy(opts: {
  socketPath?: string;
}): Promise<ProxyHandle> {
  const socketPath =
    opts.socketPath ?? `/tmp/docker-fuse-proxy-${process.pid}.sock`;
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }

  const proxyScript = resolve(REPO_ROOT, "proxy/index.js");
  const child = fork(proxyScript, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, DOCKER_PROXY_SOCKET: socketPath },
  });

  child.stdout?.on("data", (c: Buffer) =>
    process.stdout.write(`[proxy] ${c.toString()}`),
  );
  child.stderr?.on("data", (c: Buffer) =>
    process.stderr.write(`[proxy:err] ${c.toString()}`),
  );

  // Wait until the socket accepts a connection.
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (existsSync(socketPath)) {
      try {
        await new Promise<void>((res, rej) => {
          const s = createConnection(socketPath);
          s.once("connect", () => {
            s.destroy();
            res();
          });
          s.once("error", rej);
        });
        break;
      } catch {
        // not ready
      }
    }
    await sleep(100);
  }
  if (!existsSync(socketPath)) {
    child.kill("SIGTERM");
    throw new Error(`proxy socket ${socketPath} never appeared`);
  }

  return {
    socketPath,
    stop: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {}
      }
    },
  };
}

/**
 * Probe the FUSE test endpoint with retries — the container's first request
 * often takes several seconds to cold-start.
 */
export async function fetchFuseProbe(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<{
  ok: boolean;
  stage?: string;
  error?: string;
  errno?: string | number;
}> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/fuse-test`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return (await res.json()) as any;
      lastErr = new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(2000);
  }
  throw new Error(`fuse probe failed: ${String(lastErr)}`);
}
