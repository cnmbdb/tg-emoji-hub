interface Env {
  API: Fetcher;
}

const RELEASES_API =
  "https://api.github.com/repos/cnmbdb/tg-emoji-hub/releases/latest";
const RELEASE_CACHE_KEY = new Request(
  "https://tg-emoji-hub.pages.dev/__cache/latest-github-release",
);

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

    const cached = await caches.default.match(RELEASE_CACHE_KEY);
    if (cached) return cached;

    const upstream = await fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tg-emoji-hub",
      },
    });
    if (!upstream.ok) {
      return Response.json(
        { message: "Unable to read the latest GitHub release" },
        { status: 502 },
      );
    }

    const release = (await upstream.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (
      typeof release.tag_name !== "string" ||
      typeof release.html_url !== "string"
    ) {
      return Response.json(
        { message: "Invalid GitHub release response" },
        { status: 502 },
      );
    }

    const response = Response.json(
      { tag_name: release.tag_name, html_url: release.html_url },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
    await caches.default.put(RELEASE_CACHE_KEY, response.clone());
    return response;
  }

  if (!apiPath.test(url.pathname)) return context.next();
  return context.env.API.fetch(context.request);
};
