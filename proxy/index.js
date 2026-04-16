#!/usr/bin/env node

/**
 * Docker Socket Proxy
 *
 * This proxy intercepts Docker API calls and injects privileged mode
 * into container create requests. This is needed for FUSE support in
 * local development with Cloudflare Containers.
 *
 * Usage:
 *   WRANGLER_DOCKER_HOST=unix:///tmp/docker-privileged.sock wrangler dev
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const REAL_SOCKET =
  process.env.DOCKER_HOST?.replace("unix://", "") || "/var/run/docker.sock";
const PROXY_SOCKET =
  process.env.DOCKER_PROXY_SOCKET || "/tmp/docker-privileged.sock";

/**
 * Modify the container create request to add privileged mode and FUSE support
 */
function modifyCreateRequest(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);

    // Initialize HostConfig if it doesn't exist
    if (!data.HostConfig) {
      data.HostConfig = {};
    }

    // Enable privileged mode for full FUSE support (needed for docker exec to work)
    data.HostConfig.Privileged = true;

    // Add SYS_ADMIN capability for FUSE (redundant with privileged but explicit)
    if (!data.HostConfig.CapAdd) {
      data.HostConfig.CapAdd = [];
    }
    if (!data.HostConfig.CapAdd.includes("SYS_ADMIN")) {
      data.HostConfig.CapAdd.push("SYS_ADMIN");
    }

    // Add /dev/fuse device
    if (!data.HostConfig.Devices) {
      data.HostConfig.Devices = [];
    }
    const hasFuse = data.HostConfig.Devices.some(
      (d) => d.PathOnHost === "/dev/fuse",
    );
    if (!hasFuse) {
      data.HostConfig.Devices.push({
        PathOnHost: "/dev/fuse",
        PathInContainer: "/dev/fuse",
        CgroupPermissions: "rwm",
      });
    }

    // Disable AppArmor for FUSE
    if (!data.HostConfig.SecurityOpt) {
      data.HostConfig.SecurityOpt = [];
    }
    if (!data.HostConfig.SecurityOpt.includes("apparmor:unconfined")) {
      data.HostConfig.SecurityOpt.push("apparmor:unconfined");
    }

    console.log("[docker-proxy] Injected privileged mode and FUSE support");
    return JSON.stringify(data);
  } catch (e) {
    console.error("[docker-proxy] Failed to parse/modify request:", e.message);
    return bodyStr;
  }
}

/**
 * Parse HTTP request to extract method, path, headers, and body
 */
function parseHttpRequest(buffer) {
  const str = buffer.toString();
  const headerEndIndex = str.indexOf("\r\n\r\n");

  if (headerEndIndex === -1) {
    return null; // Incomplete request
  }

  const headerSection = str.substring(0, headerEndIndex);
  const lines = headerSection.split("\r\n");
  const [method, path] = lines[0].split(" ");

  // Parse headers
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIndex = lines[i].indexOf(":");
    if (colonIndex !== -1) {
      const key = lines[i].substring(0, colonIndex).toLowerCase();
      const value = lines[i].substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  const contentLength = parseInt(headers["content-length"] || "0", 10);
  const bodyStart = headerEndIndex + 4;
  const expectedLength = bodyStart + contentLength;

  if (buffer.length < expectedLength) {
    return null; // Incomplete body
  }

  const body = buffer.slice(bodyStart, expectedLength);

  return {
    method,
    path,
    headers,
    headerSection,
    body,
    totalLength: expectedLength,
  };
}

/**
 * Rebuild HTTP request with modified body
 */
function rebuildRequest(parsed, newBody) {
  const lines = parsed.headerSection.split("\r\n");

  // Update Content-Length header
  const newLines = lines.map((line) => {
    if (line.toLowerCase().startsWith("content-length:")) {
      return `Content-Length: ${newBody.length}`;
    }
    return line;
  });

  return Buffer.concat([
    Buffer.from(newLines.join("\r\n") + "\r\n\r\n"),
    Buffer.from(newBody),
  ]);
}

/**
 * Handle a client connection
 */
function handleConnection(clientSocket) {
  const dockerSocket = net.createConnection(REAL_SOCKET);
  let requestBuffer = Buffer.alloc(0);
  let requestProcessed = false;

  clientSocket.on("data", (data) => {
    if (requestProcessed) {
      // Already processed the request, just forward
      dockerSocket.write(data);
      return;
    }

    requestBuffer = Buffer.concat([requestBuffer, data]);

    const parsed = parseHttpRequest(requestBuffer);
    if (!parsed) {
      // Request not complete yet, wait for more data
      return;
    }

    requestProcessed = true;

    // Check if this is a container create request
    if (
      parsed.method === "POST" &&
      parsed.path.includes("/containers/create")
    ) {
      const modifiedBody = modifyCreateRequest(parsed.body.toString());
      const modifiedRequest = rebuildRequest(parsed, modifiedBody);
      dockerSocket.write(modifiedRequest);

      // If there's remaining data after this request, forward it
      if (requestBuffer.length > parsed.totalLength) {
        dockerSocket.write(requestBuffer.slice(parsed.totalLength));
      }
    } else {
      // Forward unmodified
      dockerSocket.write(requestBuffer);
    }
  });

  dockerSocket.on("data", (data) => {
    clientSocket.write(data);
  });

  clientSocket.on("end", () => {
    dockerSocket.end();
  });

  dockerSocket.on("end", () => {
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    if (err.code !== "ECONNRESET") {
      console.error("[docker-proxy] Client socket error:", err.message);
    }
    dockerSocket.destroy();
  });

  dockerSocket.on("error", (err) => {
    console.error("[docker-proxy] Docker socket error:", err.message);
    clientSocket.destroy();
  });
}

/**
 * Start the proxy server
 */
function startProxy() {
  // Remove existing socket file
  if (fs.existsSync(PROXY_SOCKET)) {
    fs.unlinkSync(PROXY_SOCKET);
  }

  // Ensure directory exists
  const socketDir = path.dirname(PROXY_SOCKET);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  const server = net.createServer(handleConnection);

  server.listen(PROXY_SOCKET, () => {
    // Make socket accessible
    fs.chmodSync(PROXY_SOCKET, 0o777);

    console.log("");
    console.log(
      "╔══════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║           Docker Privileged Proxy Started                    ║",
    );
    console.log(
      "╠══════════════════════════════════════════════════════════════╣",
    );
    console.log(`║  Proxy Socket:  ${PROXY_SOCKET.padEnd(44)} ║`);
    console.log(`║  Real Socket:   ${REAL_SOCKET.padEnd(44)} ║`);
    console.log(
      "╠══════════════════════════════════════════════════════════════╣",
    );
    console.log(
      "║  To use with wrangler:                                       ║",
    );
    console.log(
      `║  WRANGLER_DOCKER_HOST=unix://${PROXY_SOCKET} wrangler dev `.padEnd(
        66,
      ) + "║",
    );
    console.log(
      "╚══════════════════════════════════════════════════════════════╝",
    );
    console.log("");
  });

  server.on("error", (err) => {
    console.error("[docker-proxy] Server error:", err.message);
    process.exit(1);
  });

  // Cleanup on exit
  const cleanup = () => {
    console.log("\n[docker-proxy] Shutting down...");
    server.close();
    if (fs.existsSync(PROXY_SOCKET)) {
      fs.unlinkSync(PROXY_SOCKET);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Start the proxy
startProxy();
