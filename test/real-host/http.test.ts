// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/http.test.ts
// Local modifications (see test/PROVENANCE.md): the auth-challenge test injects the raw
// handshake transport; post-p1a02 tests below use a real LOOPBACK node:http stub.
import { describe, expect, it } from "vitest";

import { createHttpClient, createSSEParser, encodeQuery, openEventStream, readEventStream, verifyAuthChallenge } from "./http.mjs";

type Call = { url: string; init: { method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: string } };

function fakeTransport(respond: (call: Call) => { status: number; body?: string; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const transport = async (url: string, init: Call["init"]) => {
    const call = { url, init };
    calls.push(call);
    const { status, body = "", headers = {} } = respond(call);
    return new Response(status === 204 || status === 401 ? null : body, { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { calls, transport };
}

describe("loopback HTTP client", () => {
  it("refuses any base URL that is not an http loopback address with an explicit port", () => {
    for (const bad of ["https://127.0.0.1:1", "http://example.com:80", "http://localhost:4096", "http://127.0.0.1", "http://10.0.0.1:1"]) {
      expect(() => createHttpClient({ baseURL: bad }), bad).toThrow(/loopback/);
    }
    expect(() => createHttpClient({ baseURL: "http://127.0.0.1:4096" })).not.toThrow();
    expect(() => createHttpClient({ baseURL: "http://[::1]:4096" })).not.toThrow();
  });

  it("sends a bodyless POST with no body and no content type", async () => {
    const { calls, transport } = fakeTransport(() => ({ status: 204 }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport });

    const result = await client.request({ method: "POST", path: "/api/location/reload" });

    expect(result).toEqual({ status: 204, json: null, text: "", headers: { "content-type": "application/json" } });
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/location/reload");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers?.["content-type"]).toBeUndefined();
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends JSON bodies and parses JSON responses, including bare booleans", async () => {
    const { calls, transport } = fakeTransport(() => ({ status: 200, body: "true" }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport });

    const result = await client.request({ method: "POST", path: "/permission/per_1/reply", body: { reply: "once" } });

    expect(result.json).toBe(true);
    expect(JSON.parse(calls[0].init.body!)).toEqual({ reply: "once" });
    expect(calls[0].init.headers?.["content-type"]).toBe("application/json");
  });

  it("encodes deepObject location queries", () => {
    expect(encodeQuery({ location: { directory: "/tmp/fix ture" } })).toBe("location%5Bdirectory%5D=%2Ftmp%2Ffix%20ture");
    expect(encodeQuery({ directory: "/a" })).toBe("directory=%2Fa");
    expect(encodeQuery(undefined)).toBe("");
  });
});

describe("authenticated loopback control", () => {
  const auth = { username: "opencode", password: "fixture-only-password-1234" };
  const basic = `Basic ${Buffer.from("opencode:fixture-only-password-1234").toString("base64")}`;

  it("sends Basic auth and refuses redirects on every request and on the event stream", async () => {
    const { calls, transport } = fakeTransport(() => ({ status: 200, body: "[]" }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport, auth });
    await client.request({ method: "GET", path: "/session" });
    await client.open({ path: "/event" });
    for (const call of calls) {
      expect(call.init.headers?.authorization).toBe(basic);
      expect(call.init.redirect).toBe("error");
    }
    const anonymous = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport });
    await anonymous.request({ method: "GET", path: "/x" });
    expect(calls.at(-1)!.init.redirect).toBe("error");
  });

  it("can send one explicitly unauthenticated request and exposes response headers", async () => {
    const { calls, transport } = fakeTransport(() => ({ status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport, auth });
    const response = await client.request({ method: "GET", path: "/session", anonymous: true });
    expect(calls[0].init.headers?.authorization).toBeUndefined();
    expect(response.headers["www-authenticate"]).toBe('Basic realm="Secure Area"');
  });

  it("validates the fresh instance by its auth challenge before trusting the port (injected raw handshake transport)", async () => {
    const route = { method: "GET", path: "/session" };
    /** Fake of rawRequest({ origin, method, path, headers }) -> { status, headers, text }. */
    const handshake = (respond: (headers: Record<string, string>) => { status: number; headers?: Record<string, string> }) => {
      const calls: Record<string, string>[] = [];
      const fn = async ({ headers }: { headers: Record<string, string> }) => {
        calls.push(headers);
        const { status, headers: out = {} } = respond(headers);
        return { status, headers: out, text: "" };
      };
      return { calls, fn };
    };
    const client = (fn: unknown, withAuth = true) => createHttpClient({ baseURL: "http://127.0.0.1:4096", auth: withAuth ? auth : null, handshakeTransport: fn as never, transport: (() => { throw new Error("fetch must not be used for the handshake"); }) as never });
    const honest = handshake((headers) => (headers.authorization === basic ? { status: 200 } : { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } }));
    await expect(verifyAuthChallenge(client(honest.fn), route)).resolves.toEqual({ challenged: true, authorized: true });
    expect(honest.calls.map((headers) => headers.authorization)).toEqual([undefined, basic]);

    await expect(verifyAuthChallenge(client(handshake(() => ({ status: 200 })).fn), route)).rejects.toThrow(/EAUTHCHALLENGE/);
    await expect(verifyAuthChallenge(client(handshake(() => ({ status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } })).fn), route)).rejects.toThrow(/EAUTHREJECTED: auth probe GET \/session -> 401/);
    await expect(verifyAuthChallenge(client(handshake(() => ({ status: 401 })).fn), route)).rejects.toThrow(/EAUTHCHALLENGE: .* WWW-Authenticate absent/);
    expect(() => verifyAuthChallenge(client(honest.fn, false), route)).toThrow(/EAUTHSETUP/);
  });

  it("S11 diagnostic amendment: a transport failure names its handshake leg (anonymous / authenticated), keeps the code, and carries no credential or query value", async () => {
    const route = { method: "GET", path: "/session", query: { directory: "/scratch/SECRET-DIR" } };
    const secrets = ["fixture-only-password-1234", Buffer.from("opencode:fixture-only-password-1234").toString("base64"), "SECRET-DIR"];
    const { HarnessError } = await import("./http.mjs");
    const failing = (failOn: "anonymous" | "authenticated", error: unknown) => async ({ headers }: { headers: Record<string, string> }) => {
      const leg = headers.authorization ? "authenticated" : "anonymous";
      if (leg === failOn) throw error;
      return { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, text: "" };
    };
    const run = async (fn: unknown) => (await verifyAuthChallenge(createHttpClient({ baseURL: "http://127.0.0.1:4096", auth, handshakeTransport: fn as never }), route).catch((caught: unknown) => caught)) as { code: string; message: string; detail: string };
    const timeout = () => new HarnessError("EHTTPTIMEOUT", "GET /session no response within 10000 ms");
    const anonymous = await run(failing("anonymous", timeout()));
    expect(anonymous.code).toBe("EHTTPTIMEOUT");
    expect(anonymous.message).toBe("EHTTPTIMEOUT: auth handshake anonymous leg GET /session?directory=… -> GET /session no response within 10000 ms");
    const authenticated = await run(failing("authenticated", timeout()));
    expect(authenticated.code).toBe("EHTTPTIMEOUT");
    expect(authenticated.detail).toMatch(/^auth handshake authenticated leg GET \/session\?directory=… -> /);
    // A foreign error: only its validated name + code survive (never message text carrying secrets).
    const foreign = await run(failing("authenticated", Object.assign(new Error(`boom ${secrets.join(" ")} Basic ${secrets[1]}`), { code: "ECONNRESET" })));
    expect(foreign.code).toBe("ECONNRESET");
    expect(foreign.detail).toBe("auth handshake authenticated leg GET /session?directory=… -> Error ECONNRESET");
    const uncoded = await run(failing("anonymous", new Error(`x ${secrets[0]}`)));
    expect(uncoded.code).toBe("EHTTPTRANSPORT");
    for (const error of [anonymous, authenticated, foreign, uncoded]) for (const secret of secrets) expect(`${error.message} ${error.detail}`).not.toContain(secret);
  });

  it("bounds the event-stream open with an independent deadline even if the transport ignores abort", async () => {
    const hanging = async () => new Promise<Response>(() => {});
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport: hanging, auth });
    const started = Date.now();
    await expect(openEventStream(client, { path: "/event" }, { timeoutMs: 50 })).rejects.toThrow(/EEVENTSTREAM: event stream GET \/event did not open within 50 ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rejects a non-200 or bodiless event stream", async () => {
    const { transport } = fakeTransport(() => ({ status: 401 }));
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport, auth });
    await expect(openEventStream(client, { path: "/event" }, { timeoutMs: 200 })).rejects.toThrow(/EEVENTSTREAM: event stream GET \/event -> 401/);
  });
});

describe("SSE parser", () => {
  it("parses events split across chunks, multi-line data, CRLF, ids, and comments", () => {
    const parser = createSSEParser();
    expect(parser.push(": keepalive\n\nid: 1\nevent: msg\ndata: {\"a\":")).toEqual([]);
    expect(parser.push("1}\r\ndata: x\r\n\r\ndata: second\n\n")).toEqual([
      { id: "1", event: "msg", data: '{"a":1}\nx' },
      // The last event ID persists across events (SSE spec).
      { id: "1", event: "message", data: "second" },
    ]);
  });

  it("treats a CRLF split across chunks as one line ending", () => {
    const parser = createSSEParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual([{ id: "", event: "message", data: "a\nb" }]);
  });

  it("fails instead of buffering an unbounded event", () => {
    const parser = createSSEParser({ maxEventBytes: 16 });
    expect(() => parser.push(`data: ${"x".repeat(32)}`)).toThrow(/exceeds/);
  });

  it("reads a response body stream to events and stops at the abort signal", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"type\":\"server.connected\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"type\":\"two\"}\n\n"));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    await readEventStream(body, (event: { data: string }) => {
      seen.push(JSON.parse(event.data));
    });
    expect(seen).toEqual([{ type: "server.connected" }, { type: "two" }]);
  });
});

// ---------------------------------------------------------------------------
// Post Gate C p1a02 (Radagast source-verified, V2 2.0.28 026b106b / 2.0.32 843a6c51,
// packages/server/src/middleware/authorization.ts): V2 answers 401 WITHOUT WWW-Authenticate
// when the request carries `Sec-Fetch-Mode` other than absent / "navigate". Node fetch (Undici)
// always sends `Sec-Fetch-Mode: cors`, so the handshake goes through raw node:http instead.
// A real LOOPBACK stub server (127.0.0.1, ephemeral port) mimics that middleware.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach as afterEachHook } from "vitest";

import { HarnessError, rawRequest, routeLabel } from "./http.mjs";

const stubs: Server[] = [];
afterEachHook(async () => {
  for (const server of stubs.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** V2-like stub: Basic auth `opencode:<password>`; challenge header suppressed on fetch-mode requests. */
async function v2Stub({ password = "fixture-only-password-1234", handler }: { password?: string; handler?: (req: { method?: string; url?: string; headers: IncomingHttpHeaders }) => { status: number; headers?: Record<string, string>; body?: string } | null } = {}) {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const server = createServer((req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers };
    seen.push(record);
    const custom = handler?.(record);
    if (custom) {
      res.writeHead(custom.status, custom.headers ?? {});
      res.end(custom.body ?? "");
      return;
    }
    if (req.headers.authorization !== expected) {
      const mode = req.headers["sec-fetch-mode"];
      const suppress = mode !== undefined && mode !== "navigate";
      res.writeHead(401, suppress ? {} : { "www-authenticate": 'Basic realm="Secure Area"' });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseURL: `http://127.0.0.1:${port}`, seen };
}
const AUTH = { username: "opencode", password: "fixture-only-password-1234" };

describe("auth handshake over raw node:http (V2 suppresses the challenge for fetch-mode requests)", () => {
  it("fetch-based anonymous request gets a 401 WITHOUT the challenge (proves the suppression bites fetch)", async () => {
    const stub = await v2Stub();
    const client = createHttpClient({ baseURL: stub.baseURL, auth: AUTH });
    const anonymous = await client.request({ method: "GET", path: "/api/session", anonymous: true });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toBeUndefined();
    expect(stub.seen[0].headers["sec-fetch-mode"]).toBe("cors");
  });

  it("verifyAuthChallenge gets the exact challenge then 2xx, and sends NO Sec-Fetch-* header on either request", async () => {
    const stub = await v2Stub();
    const client = createHttpClient({ baseURL: stub.baseURL, auth: AUTH });
    await expect(verifyAuthChallenge(client, { method: "GET", path: "/api/session" })).resolves.toEqual({ challenged: true, authorized: true });
    expect(stub.seen).toHaveLength(2);
    for (const request of stub.seen) expect(Object.keys(request.headers).filter((key) => key.startsWith("sec-fetch-"))).toEqual([]);
    expect(stub.seen[0].headers.authorization).toBeUndefined();
    expect(stub.seen[1].headers.authorization).toBe(`Basic ${Buffer.from("opencode:fixture-only-password-1234").toString("base64")}`);
  });

  it("a V1-style query route is encoded on the raw handshake", async () => {
    const stub = await v2Stub();
    const client = createHttpClient({ baseURL: stub.baseURL, auth: AUTH });
    await verifyAuthChallenge(client, { method: "GET", path: "/session", query: { directory: "/scratch/p" } });
    expect(stub.seen.map((request) => request.url)).toEqual(["/session?directory=%2Fscratch%2Fp", "/session?directory=%2Fscratch%2Fp"]);
  });

  it("authenticated fetch requests do not depend on Sec-Fetch-Mode (2xx even though fetch sends it)", async () => {
    const stub = await v2Stub();
    const response = await createHttpClient({ baseURL: stub.baseURL, auth: AUTH }).request({ method: "GET", path: "/api/session" });
    expect(response.status).toBe(200);
    expect(stub.seen[0].headers["sec-fetch-mode"]).toBe("cors");
  });

  it.each([
    ["no challenge header", () => ({ status: 401 }), /^EAUTHCHALLENGE: auth challenge GET \/api\/session -> 401, WWW-Authenticate absent; refusing to trust the port$/],
    ["a different challenge", () => ({ status: 401, headers: { "www-authenticate": 'Basic realm="Other"' } }), /^EAUTHCHALLENGE: auth challenge GET \/api\/session -> 401, WWW-Authenticate present, not the expected Basic challenge; refusing to trust the port$/],
    ["an open listener (200)", () => ({ status: 200, body: "{}" }), /^EAUTHCHALLENGE: auth challenge GET \/api\/session -> 200, WWW-Authenticate absent; refusing to trust the port$/],
    ["the exact challenge on a non-401", () => ({ status: 403, headers: { "www-authenticate": 'Basic realm="Secure Area"' } }), /^EAUTHCHALLENGE: auth challenge GET \/api\/session -> 403, WWW-Authenticate present, the expected Basic challenge; refusing to trust the port$/],
    ["a redirect (never followed)", () => ({ status: 302, headers: { location: "http://example.com/" } }), /EAUTHCHALLENGE: auth challenge GET \/api\/session -> 302/],
  ])("anonymous probe: %s -> EAUTHCHALLENGE with status and challenge presence", async (_label, respond, message) => {
    const stub = await v2Stub({ handler: (req) => (req.headers.authorization ? null : (respond as () => { status: number })()) });
    const error = (await verifyAuthChallenge(createHttpClient({ baseURL: stub.baseURL, auth: AUTH }), { method: "GET", path: "/api/session" }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe("EAUTHCHALLENGE");
    expect(`${error.code}: ${error.detail}`).toMatch(message as RegExp);
    // The authenticated probe is never sent when the challenge is wrong.
    expect(stub.seen).toHaveLength(1);
  });

  it("wrong credentials -> EAUTHREJECTED with the status; the detail never carries the password or Authorization", async () => {
    const stub = await v2Stub({ password: "another-password-5678" });
    const error = (await verifyAuthChallenge(createHttpClient({ baseURL: stub.baseURL, auth: AUTH }), { method: "GET", path: "/api/session", query: { location: { directory: "/scratch/secret-dir" } } }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EAUTHREJECTED");
    expect(error.detail).toBe("auth probe GET /api/session?location[directory]=… -> 401");
    expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toMatch(/fixture-only-password|Basic |secret-dir/);
  });
});

describe("rawRequest: loopback-only, bounded, no redirects", () => {
  it("refuses a non-loopback or non-numeric host before connecting", async () => {
    await expect(rawRequest({ origin: "http://localhost:4096", method: "GET", path: "/" })).rejects.toThrow(/loopback/);
    await expect(rawRequest({ origin: "http://10.0.0.1:4096", method: "GET", path: "/" })).rejects.toThrow(/loopback/);
  });

  it("times out (EHTTPTIMEOUT code) when the server never answers", async () => {
    const silent = createServer(() => {});
    stubs.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const error = (await rawRequest({ origin: `http://127.0.0.1:${(silent.address() as { port: number }).port}`, method: "GET", path: "/x", timeoutMs: 200 }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EHTTPTIMEOUT");
  });

  it("bounds the body read (EHTTPBODY) and returns a 302 as-is (no redirect follow)", async () => {
    const big = await v2Stub({ handler: () => ({ status: 200, body: "x".repeat(10_000) }) });
    const error = (await rawRequest({ origin: big.baseURL, method: "GET", path: "/", maxBodyBytes: 1024 }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EHTTPBODY");
    const redirect = await v2Stub({ handler: () => ({ status: 302, headers: { location: "http://127.0.0.1:1/" } }) });
    const response = await rawRequest({ origin: redirect.baseURL, method: "GET", path: "/" });
    expect(response.status).toBe(302);
    expect(redirect.seen).toHaveLength(1);
  });
});

describe("event stream failures carry a code", () => {
  it.each([
    ["a non-200 status", (call: Call) => ({ status: 503 }) as { status: number }, /EEVENTSTREAM: event stream GET \/api\/event -> 503/],
  ])("%s -> EEVENTSTREAM", async (_label, respond, message) => {
    const { transport } = fakeTransport(respond as never);
    const error = (await openEventStream(createHttpClient({ baseURL: "http://127.0.0.1:4096", transport, auth: AUTH }), { path: "/api/event" }, { timeoutMs: 1000 }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EEVENTSTREAM");
    expect(`${error.code}: ${error.detail}`).toMatch(message);
  });

  it("an open that never resolves -> EEVENTSTREAM (timeout)", async () => {
    const transport = () => new Promise<Response>(() => {});
    const error = (await openEventStream(createHttpClient({ baseURL: "http://127.0.0.1:4096", transport: transport as never, auth: AUTH }), { path: "/api/event" }, { timeoutMs: 50 }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EEVENTSTREAM");
    expect(error.detail).toMatch(/did not open within 50 ms/);
  });
});

describe("HarnessError", () => {
  it("bounds its detail (512 chars) so a check detail stays far below the 2 KiB frame cap", () => {
    const error = new HarnessError("EX", "y".repeat(5_000));
    expect(error.detail).toHaveLength(512);
    expect(error.code).toBe("EX");
    expect(error.message).toBe(`EX: ${"y".repeat(512)}`);
    expect(error.name).toBe("Error");
  });

  it("routeLabel keeps query KEYS only (values such as directories never recorded)", () => {
    expect(routeLabel("GET", "/session", { directory: "/scratch/x" })).toBe("GET /session?directory=…");
    expect(routeLabel("GET", "/api/plugin", { location: { directory: "/scratch/x" } })).toBe("GET /api/plugin?location[directory]=…");
    expect(routeLabel("POST", "/api/session", undefined)).toBe("POST /api/session");
  });
});


describe("audit fixes: header text and transport errors never reach details", () => {
  it("EAUTHCHALLENGE never persists WWW-Authenticate header text (sentinel)", async () => {
    const SENTINEL = "SENTINEL-HEADER-TEXT-7f3a";
    const stub = await v2Stub({ handler: (req) => (req.headers.authorization ? null : { status: 401, headers: { "www-authenticate": `Basic realm="${SENTINEL}", token=${SENTINEL}` } }) });
    const error = (await verifyAuthChallenge(createHttpClient({ baseURL: stub.baseURL, auth: AUTH }), { method: "GET", path: "/api/session" }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EAUTHCHALLENGE");
    expect(error.detail).toBe("auth challenge GET /api/session -> 401, WWW-Authenticate present, not the expected Basic challenge; refusing to trust the port");
    expect(JSON.stringify({ message: error.message, detail: error.detail, stack: error.stack?.split("\n")[0] })).not.toContain(SENTINEL);
  });

  const SECRET_MESSAGE = "connect ECONNREFUSED secret-message-text /scratch/private";
  it.each([
    ["a fetch rejection with a cause code (Undici style)", () => Promise.reject(Object.assign(new TypeError(SECRET_MESSAGE), { cause: Object.assign(new Error(SECRET_MESSAGE), { code: "ECONNREFUSED" }) })), "EHTTPTRANSPORT", "probe GET /api/plugin?location[directory]=… -> transport error TypeError ECONNREFUSED"],
    ["an abort/timeout rejection", () => Promise.reject(Object.assign(new Error(SECRET_MESSAGE), { name: "TimeoutError" })), "EHTTPTRANSPORT", "probe GET /api/plugin?location[directory]=… -> transport error TimeoutError"],
    ["an unusual error name (not echoed)", () => Promise.reject(Object.assign(new Error(SECRET_MESSAGE), { name: "weird name!", code: "lowercase-code" })), "EHTTPTRANSPORT", "probe GET /api/plugin?location[directory]=… -> transport error Error"],
    ["a body-read rejection", () => Promise.resolve({ status: 200, headers: new Headers(), text: () => Promise.reject(Object.assign(new TypeError(SECRET_MESSAGE), { cause: { code: "ECONNRESET" } })) }), "EHTTPREAD", "probe GET /api/plugin?location[directory]=… -> 200, body read error TypeError ECONNRESET"],
  ])("client.request(): %s -> coded, no message text", async (_label, respond, code, detail) => {
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport: (() => (respond as () => Promise<unknown>)()) as never, auth: AUTH });
    const error = (await client.request({ method: "GET", path: "/api/plugin", query: { location: { directory: "/scratch/private" } }, operation: "probe" }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe(code);
    expect(error.detail).toBe(detail);
    expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toMatch(/secret-message-text|\/scratch\/private/);
  });

  it("client.request() without an operation label uses `request`", async () => {
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4096", transport: (() => Promise.reject(new TypeError("x"))) as never, auth: AUTH });
    const error = (await client.request({ method: "POST", path: "/api/session" }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.detail).toBe("request POST /api/session -> transport error TypeError");
  });

  it("the SSE open: a transport rejection is EEVENTSTREAM with the error tag only", async () => {
    const transport = () => Promise.reject(Object.assign(new TypeError(SECRET_MESSAGE), { cause: { code: "ECONNREFUSED" } }));
    const error = (await openEventStream(createHttpClient({ baseURL: "http://127.0.0.1:4096", transport: transport as never, auth: AUTH }), { path: "/api/event" }, { timeoutMs: 1000 }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EEVENTSTREAM");
    expect(error.detail).toBe("event stream GET /api/event -> transport error TypeError ECONNREFUSED");
    expect(error.message).not.toContain("secret-message-text");
  });

  it("rawRequest connection failures carry only the validated error tag", async () => {
    const closed = createServer();
    stubs.push(closed);
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as { port: number };
    await new Promise((resolve) => closed.close(resolve));
    stubs.splice(stubs.indexOf(closed), 1);
    const error = (await rawRequest({ origin: `http://127.0.0.1:${port}`, method: "GET", path: "/x?directory=/scratch/private" }).catch((caught: unknown) => caught)) as HarnessError;
    expect(error.code).toBe("EHTTPCONNECT");
    expect(error.detail).toBe("GET /x -> transport error Error ECONNREFUSED");
  });
});

describe("post-P1b audit (frame-2 MA1): the cell signal reaches every client request", () => {
  it("a client-level signal and a per-request signal are both combined with the request timeout", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const transport = (_url: string, init: { signal: AbortSignal }) => {
      seen.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    };
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4100", transport: transport as never, signal: controller.signal });
    const pending = client.request({ method: "GET", path: "/x", operation: "probe", timeout: 60_000 }).catch((error: { code: string; detail: string }) => error);
    controller.abort();
    const error = (await pending) as { code: string; detail: string };
    expect(error.code).toBe("EHTTPTRANSPORT");
    expect(error.detail).toBe("probe GET /x -> transport error AbortError");
    const perRequest = new AbortController();
    const second = createHttpClient({ baseURL: "http://127.0.0.1:4100", transport: transport as never });
    const pending2 = second.request({ method: "GET", path: "/y", signal: perRequest.signal, timeout: 60_000 }).catch((caught: unknown) => caught);
    perRequest.abort();
    expect(((await pending2) as { code: string }).code).toBe("EHTTPTRANSPORT");
    expect(seen).toHaveLength(2);
  });
});

describe("P1b re-audit round 2 (Should d): the cell signal reaches the raw handshake and the SSE stream", () => {
  it("rawRequest rejects an already-aborted signal without connecting, and aborts an in-flight request", async () => {
    const { rawRequest } = await import("./http.mjs");
    const { createServer } = await import("node:http");
    let connections = 0;
    const server = createServer(() => {});
    server.on("connection", () => (connections += 1));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(rawRequest({ origin, method: "GET", path: "/x", signal: aborted.signal })).rejects.toMatchObject({ code: "EABORTED" });
      expect(connections).toBe(0);
      const later = new AbortController();
      const pending = rawRequest({ origin, method: "GET", path: "/y", timeoutMs: 30_000, signal: later.signal });
      setTimeout(() => later.abort(), 20);
      await expect(pending).rejects.toMatchObject({ code: "EABORTED", detail: "GET /y -> aborted" });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("client.handshake forwards the client-level signal to the handshake transport", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const client = createHttpClient({ baseURL: "http://127.0.0.1:4100", auth: { username: "opencode", password: "p".repeat(12) }, signal: controller.signal, handshakeTransport: (async (args: { signal: unknown }) => (seen.push(args.signal), { status: 200, headers: {}, text: "" })) as never });
    await client.handshake({ method: "GET", path: "/session" });
    expect(seen).toEqual([controller.signal]);
  });

  it("openEventStream rejects an already-aborted signal without opening, and keeps forwarding abort after the stream opened", async () => {
    const opened: AbortSignal[] = [];
    const client = { open: async ({ signal }: { signal: AbortSignal }) => (opened.push(signal), new Response("data: x\n\n", { status: 200 })) };
    const aborted = new AbortController();
    aborted.abort();
    await expect(openEventStream(client as never, { path: "/event" }, { timeoutMs: 1_000, signal: aborted.signal })).rejects.toMatchObject({ code: "EEVENTSTREAM", detail: "event stream GET /event -> aborted before open" });
    expect(opened).toEqual([]);
    const cell = new AbortController();
    const stream = await openEventStream(client as never, { path: "/event" }, { timeoutMs: 1_000, signal: cell.signal });
    expect(opened[0].aborted).toBe(false);
    cell.abort();
    expect(opened[0].aborted).toBe(true);
    stream.abort();
  });
});
