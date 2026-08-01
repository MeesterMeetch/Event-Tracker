import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Reads and parses a saved feed payload from this directory. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

interface Route {
  /** Substring the request URL must contain to serve this payload. */
  contains: string;
  payload: unknown;
  /** Optional override for a non-OK response, to exercise error handling. */
  status?: number;
  /** Optional value for the `x-requests-remaining` response header (Odds API). */
  requestsRemaining?: number;
}

/**
 * Installs a `fetch` stub that answers by URL substring from the given routes.
 * Lets the tests run the real parsers against fixtures without a network call.
 * The returned object mimics enough of `Response` (json/text/headers) for both
 * the ESPN/MLB parsers and the Odds API client, which reads response headers.
 */
export function stubFetchRoutes(routes: Route[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const route = routes.find((r) => url.includes(r.contains));
      if (!route) {
        throw new Error(`No fixture route matched fetch URL: ${url}`);
      }
      const status = route.status ?? 200;
      const headers = new Map<string, string>();
      if (route.requestsRemaining != null) {
        headers.set("x-requests-remaining", String(route.requestsRemaining));
      }
      const bodyText =
        typeof route.payload === "string" ? route.payload : JSON.stringify(route.payload);
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => route.payload,
        text: async () => bodyText,
      } as unknown as Response;
    }),
  );
}
