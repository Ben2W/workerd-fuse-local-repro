#!/usr/bin/env node

/**
 * Run a command with the Docker privileged proxy
 *
 * This script:
 * 1. Starts the Docker proxy in the background
 * 2. Waits for it to be ready
 * 3. Runs the specified command with WRANGLER_DOCKER_HOST set
 * 4. Cleans up the proxy on exit
 *
 * Usage:
 *   npx with-docker-proxy wrangler dev
 *   npx with-docker-proxy -- wrangler dev --port 8787
 */

import { spawn, fork } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SOCKET = process.env.DOCKER_PROXY_SOCKET || '/tmp/docker-privileged.sock';

let proxyProcess = null;

/**
 * Wait for the proxy socket to be available
 */
async function waitForSocket(socketPath, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (fs.existsSync(socketPath)) {
      // Try to connect
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(socketPath);
          socket.on('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.on('error', reject);
        });
        return true;
      } catch {
        // Socket exists but not ready yet
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }

  return false;
}

/**
 * Start the proxy process
 */
function startProxy() {
  const proxyScript = path.join(__dirname, 'index.js');
  proxyProcess = fork(proxyScript, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      DOCKER_PROXY_SOCKET: PROXY_SOCKET
    }
  });

  proxyProcess.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  proxyProcess.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  return proxyProcess;
}

/**
 * Cleanup function
 */
function cleanup() {
  if (proxyProcess) {
    proxyProcess.kill('SIGTERM');
    proxyProcess = null;
  }
  if (fs.existsSync(PROXY_SOCKET)) {
    try {
      fs.unlinkSync(PROXY_SOCKET);
    } catch {}
  }
}

async function main() {
  // Get command to run (everything after --)
  const args = process.argv.slice(2);
  const dashDashIndex = args.indexOf('--');

  let command;
  let commandArgs;

  if (dashDashIndex !== -1) {
    command = args[dashDashIndex + 1];
    commandArgs = args.slice(dashDashIndex + 2);
  } else if (args.length > 0) {
    command = args[0];
    commandArgs = args.slice(1);
  } else {
    console.error('Usage: with-docker-proxy <command> [args...]');
    console.error('       with-docker-proxy -- <command> [args...]');
    process.exit(1);
  }

  // Setup cleanup handlers
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);

  // Start the proxy
  console.log('[with-docker-proxy] Starting Docker privileged proxy...');
  startProxy();

  // Wait for proxy to be ready
  const ready = await waitForSocket(PROXY_SOCKET);
  if (!ready) {
    console.error('[with-docker-proxy] Proxy failed to start');
    cleanup();
    process.exit(1);
  }

  console.log('[with-docker-proxy] Proxy ready, starting command...\n');

  // Run the command with the proxy socket
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_DOCKER_HOST: `unix://${PROXY_SOCKET}`,
      DOCKER_HOST: `unix://${PROXY_SOCKET}`
    },
    shell: true
  });

  child.on('close', (code) => {
    cleanup();
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error('[with-docker-proxy] Failed to start command:', err.message);
    cleanup();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
