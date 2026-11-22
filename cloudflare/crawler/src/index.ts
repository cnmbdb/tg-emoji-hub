import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  CRAWLER: DurableObjectNamespace<CrawlerContainer>;
  MEDIA: R2Bucket;
  MYSQL_HOST: string;
  MYSQL_PORT: string;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
  MYSQL_DATABASE: string;
  TG_API_ID?: string;
  TG_API_HASH?: string;
  TG_PHONE?: string;
  TG_SESSION_STRING?: string;
  TG_SESSION_NAME: string;
  CRAWLER_SIGNALS_DIR: string;
  THUMBNAIL_DIR: string;
  MEDIA_DIR: string;
  SESSION_DIR: string;
  CRAWLER_HEALTH_PORT: string;
  LOG_LEVEL: string;
  DOWNLOAD_ORIGINALS: string;
  R2_BASE_URL: string;
}

const PORT = 8081;
const ALARM_INTERVAL_MS = 5 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

function telegramSecretsReady(env: Env): boolean {
  const values = [env.TG_API_ID, env.TG_API_HASH, env.TG_PHONE, env.TG_SESSION_STRING];
  return values.every((value) => Boolean(value) && !value!.startsWith("REPLACE_ME_"));
}

export class CrawlerContainer extends DurableObject<Env> {
  private starting?: Promise<void>;

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__wake") {
      return new Response("not found", { status: 404 });
    }
    if (!telegramSecretsReady(this.env)) {
      return new Response("Telegram credentials or session are not configured", { status: 503 });
    }
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    return new Response("crawler running");
  }

  async alarm(): Promise<void> {
    if (!telegramSecretsReady(this.env)) return;
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
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
          TG_API_ID: this.env.TG_API_ID!,
          TG_API_HASH: this.env.TG_API_HASH!,
          TG_PHONE: this.env.TG_PHONE!,
          TG_SESSION_STRING: this.env.TG_SESSION_STRING!,
          TG_SESSION_NAME: this.env.TG_SESSION_NAME,
          CRAWLER_SIGNALS_DIR: this.env.CRAWLER_SIGNALS_DIR,
          THUMBNAIL_DIR: this.env.THUMBNAIL_DIR,
          MEDIA_DIR: this.env.MEDIA_DIR,
          SESSION_DIR: this.env.SESSION_DIR,
          CRAWLER_HEALTH_PORT: this.env.CRAWLER_HEALTH_PORT,
          LOG_LEVEL: this.env.LOG_LEVEL,
          DOWNLOAD_ORIGINALS: this.env.DOWNLOAD_ORIGINALS,
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
    throw new Error("Crawler container did not become healthy", { cause: lastError });
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
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (!telegramSecretsReady(env)) {
      console.warn("Crawler idle: Telegram API credentials and TG_SESSION_STRING are required");
      return;
    }
    const crawler = env.CRAWLER.getByName("production-crawler");
    const response = await crawler.fetch("https://crawler/__wake");
    if (!response.ok) throw new Error(`Crawler wake failed: ${response.status}`);
  },
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
