interface Env {
  API: Fetcher;
}

const apiPath = /^\/(api(?:\/|$)|healthz$|mcp(?:\/|$)|thumbs\/|emoji\/)/;

export const onRequest = async (context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> => {
  const url = new URL(context.request.url);
  if (!apiPath.test(url.pathname)) return context.next();
  return context.env.API.fetch(context.request);
};
