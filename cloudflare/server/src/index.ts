import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  SERVER: DurableObjectNamespace<ServerContainer>;
  MEDIA: R2Bucket;
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
    const current = await container.inspect();
    if (current && current.image !== container.images.base) {
      await container.destroy("Refreshing to the configured container image");
    }
    await container.interceptOutboundHttp(
      "r2.internal",
      this.ctx.exports.MediaGateway({ props: {} }),
    );
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
          R2_BASE_URL: "http://r2.internal/objects",
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

export class MediaGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/objects/_list" && request.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!/^(signals|thumbs|media)\/$/.test(prefix)) {
        return new Response("invalid prefix", { status: 400 });
      }
      const listed = await this.env.MEDIA.list({
        prefix: `tg-emoji-hub/${prefix}`,
        limit: 1000,
      });
      return Response.json({
        keys: listed.objects.map((object) => object.key.slice("tg-emoji-hub/".length)),
        truncated: listed.truncated,
      });
    }

    if (!url.pathname.startsWith("/objects/")) {
      return new Response("not found", { status: 404 });
    }
    const key = url.pathname.slice("/objects/".length);
    if (!/^(signals|thumbs|media)\/[A-Za-z0-9_.-]+$/.test(key) || key.includes("..")) {
      return new Response("invalid key", { status: 400 });
    }
    const objectKey = `tg-emoji-hub/${key}`;

    if (request.method === "PUT") {
      await this.env.MEDIA.put(objectKey, request.body, {
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.env.MEDIA.delete(objectKey);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const object = await this.env.MEDIA.get(objectKey);
      if (!object) return new Response("not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(request.method === "HEAD" ? null : object.body, { headers });
    }
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD, PUT, DELETE" } });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const id = env.SERVER.idFromName("production-server");
    return env.SERVER.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
