import { DurableObject } from "cloudflare:workers";

interface Env {
  SERVER: DurableObjectNamespace<ServerContainer>;
  MYSQL_HOST: string;
  MYSQL_PORT: string;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
  MYSQL_DATABASE: string;
  PUBLIC_URL: string;
  LOG_LEVEL: string;
}

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class ServerContainer extends DurableObject<Env> {
  private starting?: Promise<void>;

  async fetch(request: Request): Promise<Response> {
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWait(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: "basic",
        enableInternet: true,
        env: {
          MYSQL_HOST: this.env.MYSQL_HOST,
          MYSQL_PORT: this.env.MYSQL_PORT,
          MYSQL_USER: this.env.MYSQL_USER,
          MYSQL_PASSWORD: this.env.MYSQL_PASSWORD,
          MYSQL_DATABASE: this.env.MYSQL_DATABASE,
          PUBLIC_URL: this.env.PUBLIC_URL,
          LOG_LEVEL: this.env.LOG_LEVEL,
        },
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await port.fetch("http://container/healthz", {
          signal: AbortSignal.timeout(1500),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`healthz returned ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(500);
      }
    }
    throw new Error("Server container did not become healthy", { cause: lastError });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const id = env.SERVER.idFromName("production-server");
    return env.SERVER.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
