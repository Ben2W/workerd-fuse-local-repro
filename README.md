# Cloudflare Containers: FUSE broken in local dev

Workers that use [Cloudflare Containers](https://developers.cloudflare.com/containers/) can mount FUSE filesystems in production, but the same Workers break silently in local dev (`wrangler dev`).

This repo is a minimal, reproducible demonstration of:

1. The bug: **stock `wrangler dev` / `workerd` does not expose `/dev/fuse` or grant `CAP_SYS_ADMIN`** to the local container, so any FUSE mount attempt fails.
2. A runtime **workaround**: a Docker socket proxy that intercepts `POST /containers/create` and injects the four HostConfig fields the container needs. With the proxy in place, FUSE mounts work.
3. A **one-file fix in `workerd`** that applies the same four fields natively in `ContainerClient::createContainer()`. With the patched `workerd`, FUSE mounts work with no proxy in the loop.

All three states are asserted end-to-end by a single `vitest` run. The "FUSE works" assertion is not a device-existence check — the container runs the libc `mount("fuse", …, fd=…)` syscall directly and verifies it succeeds.

## Proposed upstream fix

I've opened a PR against `cloudflare/workerd` with the 32-line diff that fixes this at the source: **https://github.com/cloudflare/workerd/pull/6596**.

The patch is also committed here at [`patches/workerd-fuse-local-dev.patch`](patches/workerd-fuse-local-dev.patch).

## Quick start

Prerequisites: Docker Desktop running, Node 20+, ~1 GB free disk (the container image is small; the `.wrangler` build cache grows).

```sh
git clone https://github.com/Ben2W/workerd-fuse-local-repro.git
cd workerd-fuse-local-repro
npm install
npm test
```

What you'll see:

```
 ✓ FUSE in local Cloudflare Container — baseline (broken)
 ✓ FUSE in local Cloudflare Container — with Docker proxy (fixed)
 ↓ FUSE in local Cloudflare Container — patched workerd, no proxy (upstream fix)  [skipped]

 Tests  2 passed | 1 skipped (3)
```

The third test auto-skips unless a custom-built `workerd` binary exists at `research/workerd/bazel-bin/src/workerd/server/workerd`. See "Verify the upstream fix" below to build it.

## What each scenario does

### 1. Baseline (broken)

```sh
npm run dev
curl http://localhost:8787/fuse-test
# → {"ok":false,"stage":"device","error":"/dev/fuse not present"}
```

`wrangler dev` spins up the user's container through a stock Docker daemon call. The container probe tries to `stat("/dev/fuse")` first; it fails immediately. If `/dev/fuse` were present on your Docker host, the probe would continue to `open("/dev/fuse")` and then `mount("fuse", …)` — both of which would also fail for lack of `CAP_SYS_ADMIN`.

### 2. With the Docker proxy (workaround)

```sh
npm run dev:with-proxy
curl http://localhost:8787/fuse-test
# → {"ok":true,"stage":"mount"}
```

A small Node script ([`proxy/index.js`](proxy/index.js)) listens on a Unix socket, forwards all Docker API traffic to the real daemon, and rewrites `POST /containers/create` requests on the fly to add:

- `HostConfig.Privileged = true`
- `HostConfig.CapAdd += "SYS_ADMIN"`
- `HostConfig.Devices += { PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }`
- `HostConfig.SecurityOpt += "apparmor:unconfined"`

`wrangler dev` is pointed at the proxy socket via `WRANGLER_DOCKER_HOST`. Because the only thing that changed between scenarios 1 and 2 is those four HostConfig fields, this is direct evidence that those four fields are both necessary and sufficient to make FUSE work in the local container.

### 3. With a patched workerd (upstream fix)

The same four fields, applied inside workerd's source at [`src/workerd/server/container-client.c++` in `ContainerClient::createContainer()`](patches/workerd-fuse-local-dev.patch). The vitest scenario points `MINIFLARE_WORKERD_PATH` at a custom-built binary and re-runs the same probe — it succeeds. No proxy in the loop.

## Verify the upstream fix locally

Prereqs on macOS: Xcode ≥ 16.3, `brew install bazelisk tcl-tk`, ~30 GB free disk (bazel cache), ~30–60 min for the first build (subsequent builds are incremental).

```sh
# Clone my workerd branch with the fix
git clone https://github.com/Ben2W/workerd.git
cd workerd
git checkout fuse-local-dev-support

# Release-style build (opt mode disables a noisy debug-only assertion in
# workerd/jsg/jsg.c++:137 that is pre-existing and unrelated to this fix)
bazel build //src/workerd/server:workerd -c opt

# Point this repro at the patched binary and re-run the suite
export MINIFLARE_WORKERD_PATH="$PWD/bazel-bin/src/workerd/server/workerd"
cd /path/to/workerd-fuse-local-repro
npm test
```

Expected: **3/3 passing**. The scenario that was skipped is now run, and it asserts that a real `mount("fuse", …)` syscall succeeds inside the local container with no proxy.

## How the probe works

The container is a small Debian + Python image ([`container/Dockerfile`](container/Dockerfile), [`container/server.py`](container/server.py)) that on `GET /fuse-test` runs:

1. `os.stat("/dev/fuse")` — fails with `device` if not present
2. `os.open("/dev/fuse", O_RDWR)` — fails with `open` if no permission
3. `libc.mount("fuse", mnt, "fuse", MS_NODEV|MS_NOSUID, "fd=…,…")` — fails with `mount` if `CAP_SYS_ADMIN` is missing or the device file descriptor is rejected

Step 3 is the ground truth: it's the same `mount()` syscall libfuse uses. If it succeeds inside the container, FUSE works for any real Worker using the Containers FUSE binding.

## Layout

```
.
├── src/worker.ts                  Worker entrypoint: forwards fetch() to the container
├── container/
│   ├── Dockerfile                 Debian + fuse3 + Python
│   └── server.py                  HTTP server running the FUSE probe
├── proxy/
│   ├── index.js                   Unix-socket Docker proxy that injects HostConfig
│   └── with-docker-proxy.js       Wrapper: start proxy + run a command with it
├── tests/
│   ├── fuse.test.ts               Three scenarios (baseline / proxy / patched)
│   └── helpers.ts                 Spawn wrangler dev, await readiness, probe
├── patches/
│   └── workerd-fuse-local-dev.patch   The proposed workerd change
├── wrangler.jsonc                 Container binding config
└── vitest.config.ts
```

## Known caveats

- Debug-mode builds of workerd (`bazel build //src/workerd/server:workerd` with no flag) hit a pre-existing `KJ_FAIL_REQUIRE("attempt to take recursive isolate lock")` at `src/workerd/jsg/jsg.c++:137` on the `/fuse-test` request path. The TODO comment right above the assertion acknowledges this is a known latent bug. Opt builds (`-c opt`) downgrade it to a log-and-continue. This is unrelated to the FUSE fix.
- The Docker proxy also sets `Privileged: true`, which the upstream patch mirrors. A narrower alternative (only `CapAdd + Devices + SecurityOpt`, no full Privileged) may be sufficient for the FUSE mount syscall itself but was not tested here.
