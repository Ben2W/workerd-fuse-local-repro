import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchFuseProbe,
  REPO_ROOT,
  spawnWrangler,
  startDockerProxy,
  type ProxyHandle,
  type WranglerHandle,
} from "./helpers";

const PATCHED_WORKERD = resolve(
  REPO_ROOT,
  "research/workerd/bazel-bin/src/workerd/server/workerd",
);
const HAS_PATCHED_WORKERD = existsSync(PATCHED_WORKERD);

/**
 * Baseline: this documents the bug.
 *
 * When `wrangler dev` (→ workerd/miniflare) spins up a Cloudflare Container
 * locally, it POSTs to /containers/create without Privileged, without
 * CapAdd=[SYS_ADMIN], and without binding /dev/fuse. So a real FUSE mount
 * inside the container fails — /dev/fuse isn't present, and even if it
 * were, the mount() syscall would EPERM for lack of CAP_SYS_ADMIN.
 */
describe("FUSE in local Cloudflare Container — baseline (broken)", () => {
  let wrangler: WranglerHandle;

  beforeAll(async () => {
    wrangler = await spawnWrangler({ port: 8799 });
  }, 300_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("fails to mount FUSE (this is the bug)", async () => {
    const result = await fetchFuseProbe(wrangler.port);
    expect(result.ok).toBe(false);
    // We don't over-specify the stage because it depends on the Docker host —
    // on colima/lima /dev/fuse may not exist at all (stage=device), on a Linux
    // host it exists but can't be opened/mounted (stage=open|mount).
    expect(["device", "open", "mount"]).toContain(result.stage);
  });
});

/**
 * Workaround: the Docker proxy intercepts /containers/create and injects
 * Privileged=true, CapAdd=[SYS_ADMIN], Devices=[{/dev/fuse}], and
 * SecurityOpt=[apparmor:unconfined]. With those flags, FUSE mounts work.
 *
 * This is the same behavior we'll want workerd/miniflare to apply when a
 * user declares they need FUSE (or unconditionally in local dev, depending
 * on the fix we pick).
 */
describe("FUSE in local Cloudflare Container — with Docker proxy (fixed)", () => {
  let proxy: ProxyHandle;
  let wrangler: WranglerHandle;

  beforeAll(async () => {
    proxy = await startDockerProxy({});
    wrangler = await spawnWrangler({
      port: 8800,
      env: { WRANGLER_DOCKER_HOST: `unix://${proxy.socketPath}` },
    });
  }, 300_000);

  afterAll(async () => {
    await wrangler?.stop();
    await proxy?.stop();
  });

  it("mounts FUSE successfully (this is what the workerd fix must achieve)", async () => {
    const result = await fetchFuseProbe(wrangler.port);
    expect(
      result.ok,
      `expected FUSE mount to succeed with proxy, got: ${JSON.stringify(result)}`,
    ).toBe(true);
    expect(result.stage).toBe("mount");
  });
});

/**
 * Upstream fix: the same four Docker HostConfig fields the proxy injects,
 * but applied inside workerd's ContainerClient::createContainer() at the
 * source. Miniflare is pointed at our custom build via MINIFLARE_WORKERD_PATH.
 *
 * If this scenario passes with no proxy in the loop, the workerd patch is
 * sufficient on its own — which is what we want to tell Cloudflare.
 */
describe.skipIf(!HAS_PATCHED_WORKERD)(
  "FUSE in local Cloudflare Container — patched workerd, no proxy (upstream fix)",
  () => {
    let wrangler: WranglerHandle;

    beforeAll(async () => {
      wrangler = await spawnWrangler({
        port: 8801,
        env: { MINIFLARE_WORKERD_PATH: PATCHED_WORKERD },
      });
    }, 300_000);

    afterAll(async () => {
      await wrangler?.stop();
    });

    it("mounts FUSE successfully with stock Docker socket", async () => {
      const result = await fetchFuseProbe(wrangler.port);
      expect(
        result.ok,
        `expected FUSE mount to succeed with patched workerd, got: ${JSON.stringify(result)}`,
      ).toBe(true);
      expect(result.stage).toBe("mount");
    });
  },
);
