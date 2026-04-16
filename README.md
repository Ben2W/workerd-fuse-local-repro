# Cloudflare Containers: FUSE broken in local dev

Workers that use [Cloudflare Containers](https://developers.cloudflare.com/containers/) can mount FUSE filesystems in production, but the same Workers break silently in local dev (`wrangler dev`).

This repo is a minimal, reproducible demonstration of:

1. The bug: **stock `wrangler dev` / `workerd` does not expose `/dev/fuse` or grant `CAP_SYS_ADMIN`** to the local container, so any FUSE mount attempt fails.
2. A runtime **workaround**: a Docker socket proxy that intercepts `POST /containers/create` and injects the four HostConfig fields the container needs. With the proxy in place, FUSE mounts work.

## Proposed upstream fix

I've opened a PR against `cloudflare/workerd` that fixes this: **https://github.com/cloudflare/workerd/pull/6596**.

## Quick start

Prerequisites: Docker Desktop running, Node 20+, ~1 GB free disk (the container image is small; the `.wrangler` build cache grows).

```sh
git clone https://github.com/Ben2W/workerd-fuse-local-repro.git
cd workerd-fuse-local-repro
npm install
npm test
```

### 1. Baseline (broken)

```sh
npm run dev
curl http://localhost:8787/fuse-test
# → {"ok":false,"stage":"device","error":"/dev/fuse not present"}
```

### 2. With the Docker proxy (workaround)

```sh
npm run dev:with-proxy
curl http://localhost:8787/fuse-test
# → {"ok":true,"stage":"mount"}
```
