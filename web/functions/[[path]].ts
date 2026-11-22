interface Env {
  API: Fetcher;
}

const LATEST_RELEASE_URL =
  "https://github.com/cnmbdb/tg-emoji-hub/releases/latest";

const apiPath = /^\/(api(?:\/|$)|healthz$|mcp(?:\/|$)|thumbs\/|emoji\/)/;

export const onRequest = async (context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> => {
  const url = new URL(context.request.url);

  if (url.pathname === "/api/version") {
    if (context.request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const fallbackTag = url.searchParams.get("fallback") ?? "latest";
    const releaseCacheKey = new Request(
      `https://tg-emoji-hub.pages.dev/__cache/latest-github-release?fallback=${encodeURIComponent(fallbackTag)}`,
    );
    const cached = await caches.default.match(releaseCacheKey);
    if (cached) return cached;

    const upstream = await fetch(LATEST_RELEASE_URL, {
      headers: {
        "User-Agent": "tg-emoji-hub",
      },
    });
    if (!upstream.ok) {
      return Response.json(
        { message: "Unable to read the latest GitHub release" },
        { status: 502 },
      );
    }

    const redirectedUrl = new URL(upstream.url);
    const tagMatch = redirectedUrl.pathname.match(
      /^\/cnmbdb\/tg-emoji-hub\/releases\/tag\/([^/]+)\/?$/,
    );
    if (!tagMatch) {
      return Response.json(
        { message: "Unable to resolve the latest GitHub release tag" },
        { status: 502 },
      );
    }
    const tagName = decodeURIComponent(tagMatch[1]);

    const response = Response.json(
      {
        tag_name: tagName,
        html_url: `https://github.com/cnmbdb/tg-emoji-hub/releases/tag/${encodeURIComponent(tagName)}`,
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
    await caches.default.put(releaseCacheKey, response.clone());
    return response;
  }

  if (!apiPath.test(url.pathname)) return context.next();
  return context.env.API.fetch(context.request);
};
