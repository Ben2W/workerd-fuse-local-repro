import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  FUSE_CONTAINER: DurableObjectNamespace<FuseContainer>;
}

export class FuseContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
}

export default {
  async fetch(request, env): Promise<Response> {
    const container = getContainer(env.FUSE_CONTAINER);
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
