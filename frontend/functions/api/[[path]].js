// Hands every request under this path, unchanged, to the API Worker through the API service
// binding (frontend/wrangler.toml). The site and the API therefore share this origin, which the
// SameSite=Strict refresh cookie needs, and the Worker itself has no public address.

/** @param {{ request: Request, env: { API: { fetch: (r: Request) => Promise<Response> } } }} context */
export const onRequest = ({ request, env }) => env.API.fetch(request);
