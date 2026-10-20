// Provenance: COPIED from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/http.mjs
// Local modifications (see test/PROVENANCE.md):
//   1. (post Gate C p1a02) The auth handshake (anonymous challenge + authenticated probe) goes
//      through raw node:http (`rawRequest`), which sends no Sec-Fetch-* headers: V2
//      (2.0.28 / 2.0.32, packages/server/src/middleware/authorization.ts) answers 401 WITHOUT
//      WWW-Authenticate when Sec-Fetch-Mode is present and not "navigate", and Node fetch
//      (Undici) always sends `Sec-Fetch-Mode: cors`. Every later request is authenticated, and
//      authenticated requests do not depend on Sec-Fetch-Mode, so they stay on fetch (which
//      also provides the streaming body the SSE reader uses).
//   2. Every throw carries a stable code and a bounded, sanitized `detail` (HarnessError):
//      operation, method, route path (query KEYS only), status, challenge presence / exact match,
//      validated error tags (`errorTag`: name + code, never message text). Never the
//      Authorization header, the password, query values, header text, or bodies.
//   3. (S11 diagnostic amendment) handshake transport failures name their leg: "auth handshake
//      anonymous leg <route>" / "auth handshake authenticated leg <route>", code kept.
// Minimal loopback-only HTTP client and bounded SSE parser for host control.
// The fetch transport is injectable so unit tests need not open sockets.
import { request as httpRequest } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const MAX_DETAIL_CHARS = 512;

/** A harness failure with a stable `code` and a bounded, sanitized `detail` (safe to put in results). */
export class HarnessError extends Error {
  constructor(code, detail) {
    const bounded = String(detail).slice(0, MAX_DETAIL_CHARS);
    super(`${code}: ${bounded}`);
    this.name = "Error";
    this.code = code;
    this.detail = bounded;
  }
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TAG_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** `<Name> [<CODE>]` from an error (cause code preferred, as Undici nests it); validated, never message text. */
export function errorTag(error) {
  const name = typeof error?.name === "string" && TAG_NAME.test(error.name) ? error.name : "Error";
  const code = [error?.cause?.code, error?.code].find((value) => typeof value === "string" && TAG_CODE.test(value));
  return code ? `${name} ${code}` : name;
}

/** `METHOD /path?key=…&k2=…`: query values are never recorded (directories, ids). */
export function routeLabel(method, path, query) {
  const keys = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") for (const [inner, innerValue] of Object.entries(value)) innerValue !== undefined && keys.push(`${key}[${inner}]`);
    else keys.push(key);
  }
  return `${method} ${path}${keys.length ? `?${keys.map((key) => `${key}=…`).join("&")}` : ""}`;
}

export function encodeQuery(query) {
  if (!query) return "";
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue !== undefined) parts.push(`${encodeURIComponent(`${key}[${inner}]`)}=${encodeURIComponent(String(innerValue))}`);
      }
    } else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

export function assertLoopbackBaseURL(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`base URL is not a loopback http URL: ${baseURL}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.port === "" || url.username || url.password) {
    throw new Error(`base URL is not a loopback http URL with an explicit port: ${baseURL}`);
  }
  return url;
}

export const AUTH_CHALLENGE = 'Basic realm="Secure Area"';
const RAW_MAX_BODY_BYTES = 64 * 1024;

/**
 * Raw node:http request (no fetch metadata headers, no keep-alive agent, redirects never
 * followed). Loopback numeric hosts only; bounded by `timeoutMs` and `maxBodyBytes`.
 * Resolves { status, headers (lowercase), text }.
 */
export function rawRequest({ origin, method, path, headers = {}, timeoutMs = 10_000, maxBodyBytes = RAW_MAX_BODY_BYTES, signal = null }) {
  let url;
  try {
    url = assertLoopbackBaseURL(origin);
  } catch (error) {
    return Promise.reject(error);
  }
  // Re-audit round 2 (Should d): the cell signal reaches the raw handshake too.
  const abortedError = () => new HarnessError("EABORTED", `${method} ${path.split("?")[0]} -> aborted`);
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      req.destroy();
      done(reject, abortedError());
    };
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const req = httpRequest({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port), method, path, headers, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          req.destroy();
          done(reject, new HarnessError("EHTTPBODY", `${method} ${path.split("?")[0]} response body exceeds ${maxBodyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const lower = {};
        for (const [key, value] of Object.entries(res.headers)) lower[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        done(resolve, { status: res.statusCode, headers: lower, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (error) => done(reject, new HarnessError("EHTTPREAD", `${method} ${path.split("?")[0]} -> ${res.statusCode}, body read error ${errorTag(error)}`)));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new HarnessError("EHTTPTIMEOUT", `${method} ${path.split("?")[0]} no response within ${timeoutMs} ms`));
    }, timeoutMs);
    req.on("error", (error) => done(reject, new HarnessError("EHTTPCONNECT", `${method} ${path.split("?")[0]} -> transport error ${errorTag(error)}`)));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

export function createHttpClient({ baseURL, transport = globalThis.fetch, timeoutMs = 10_000, auth = null, handshakeTransport = rawRequest, signal: clientSignal = null }) {
  const base = assertLoopbackBaseURL(baseURL);
  const origin = `${base.protocol}//${base.host}`;
  const authorization = auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` : null;
  const headersFor = (extra, anonymous) => ({ ...extra, ...(authorization && !anonymous ? { authorization } : {}) });
  return {
    origin,
    hasAuth: Boolean(authorization),
    url(path, query) {
      const encoded = encodeQuery(query);
      return `${origin}${path}${encoded ? `?${encoded}` : ""}`;
    },
    /** Every request refuses redirects so traffic can never be bounced to another listener. */
    async request({ method, path, query, body, timeout = timeoutMs, anonymous = false, operation = "request", signal = null }) {
      const extra = {};
      // Post-P1b audit: the cell signal (client-level and / or per request) aborts the request too.
      const signals = [AbortSignal.timeout(timeout), clientSignal, signal].filter(Boolean);
      const init = { method, redirect: "error", signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        extra["content-type"] = "application/json";
      }
      init.headers = headersFor(extra, anonymous);
      const label = `${operation} ${routeLabel(method, path, query)}`;
      // Transport and body-read failures are coded; only the validated error tag is kept (no message text).
      let response;
      try {
        response = await transport(this.url(path, query), init);
      } catch (error) {
        throw new HarnessError("EHTTPTRANSPORT", `${label} -> transport error ${errorTag(error)}`);
      }
      let text = "";
      if (response.status !== 204 && response.status !== 401) {
        try {
          text = await response.text();
        } catch (error) {
          throw new HarnessError("EHTTPREAD", `${label} -> ${response.status}, body read error ${errorTag(error)}`);
        }
      }
      let json = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      const headers = {};
      response.headers?.forEach?.((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, json, text, headers };
    },
    /** Auth handshake request over raw node:http (no Sec-Fetch-* headers); anonymous or with Basic auth. */
    async handshake({ method, path, query, timeout = timeoutMs, anonymous = false }) {
      const encoded = encodeQuery(query);
      return handshakeTransport({ origin, method, path: `${path}${encoded ? `?${encoded}` : ""}`, headers: headersFor({ accept: "application/json" }, anonymous), timeoutMs: timeout, signal: clientSignal });
    },
    /** Opens an SSE stream; returns the raw fetch Response (read body with readEventStream). */
    async open({ path, query, signal }) {
      return transport(this.url(path, query), { method: "GET", redirect: "error", headers: headersFor({ accept: "text/event-stream" }, false), signal });
    },
  };
}

/**
 * Identity of a freshly started host on an allocated port: an unauthenticated
 * request must receive the exact Basic challenge (so this is not some other
 * open listener), and the same request with the fixture-only credentials must
 * succeed (so it is the instance we started with that password). No other
 * request may be sent before this passes.
 */
export function verifyAuthChallenge(client, route) {
  if (!client.hasAuth) throw new HarnessError("EAUTHSETUP", "auth challenge verification requires fixture credentials");
  const label = routeLabel(route.method, route.path, route.query);
  /**
   * S11 diagnostic amendment: a transport failure names its leg (anonymous challenge vs
   * authenticated probe) with the credential-free route label (query KEYS only), keeping the
   * stable code; a foreign error contributes only its validated name + code, never message text.
   */
  const leg = async (name, send) => {
    try {
      return await send();
    } catch (error) {
      const code = typeof error?.code === "string" && TAG_CODE.test(error.code) ? error.code : "EHTTPTRANSPORT";
      const inner = error instanceof HarnessError ? error.detail : errorTag(error);
      throw new HarnessError(code, `auth handshake ${name} leg ${label} -> ${inner}`);
    }
  };
  return (async () => {
    // Both requests over raw node:http: fetch's Sec-Fetch-Mode makes V2 omit the challenge.
    const anonymous = await leg("anonymous", () => client.handshake({ ...route, anonymous: true }));
    const challenge = anonymous.headers["www-authenticate"];
    if (anonymous.status !== 401 || challenge !== AUTH_CHALLENGE) {
      // Presence and exact-match only: the header's text is host-controlled and never persisted.
      const shown = challenge === undefined ? "absent" : challenge === AUTH_CHALLENGE ? "present, the expected Basic challenge" : "present, not the expected Basic challenge";
      throw new HarnessError("EAUTHCHALLENGE", `auth challenge ${label} -> ${anonymous.status}, WWW-Authenticate ${shown}; refusing to trust the port`);
    }
    const authorized = await leg("authenticated", () => client.handshake(route));
    if (authorized.status < 200 || authorized.status >= 300) throw new HarnessError("EAUTHREJECTED", `auth probe ${label} -> ${authorized.status}`);
    return { challenged: true, authorized: true };
  })();
}

/** Opens the event stream with a deadline that holds even if the transport ignores abort. */
export async function openEventStream(client, route, { timeoutMs, signal }) {
  // Re-audit round 2 (Should d): an already-aborted cell signal opens nothing; once open, the
  // signal keeps aborting the stream until it is closed (the listener is dropped only on close).
  if (signal?.aborted) throw new HarnessError("EEVENTSTREAM", `event stream ${routeLabel("GET", route.path, route.query)} -> aborted before open`);
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  const close = () => {
    signal?.removeEventListener("abort", forward);
    controller.abort();
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HarnessError("EEVENTSTREAM", `event stream ${routeLabel("GET", route.path, route.query)} did not open within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([client.open({ ...route, signal: controller.signal }), deadline]);
    if (response.status !== 200 || !response.body) throw new HarnessError("EEVENTSTREAM", `event stream ${routeLabel("GET", route.path, route.query)} -> ${response.status}${response.body ? "" : ", no body"}`);
    return { response, abort: close };
  } catch (error) {
    close();
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("EEVENTSTREAM", `event stream ${routeLabel("GET", route.path, route.query)} -> transport error ${errorTag(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createSSEParser({ maxEventBytes = 1_048_576 } = {}) {
  let buffer = "";
  let data = [];
  let event = "";
  let id = "";
  function line(text) {
    if (text === "") {
      if (data.length === 0) {
        event = "";
        return null;
      }
      const dispatched = { id, event: event || "message", data: data.join("\n") };
      data = [];
      event = "";
      return dispatched;
    }
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    return null;
  }
  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // A trailing lone CR may be the first half of a CRLF split across chunks.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        const dispatched = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (dispatched) events.push(dispatched);
      }
      const pending = buffer.length + data.reduce((sum, part) => sum + part.length, 0);
      if (pending > maxEventBytes) throw new Error(`SSE event exceeds ${maxEventBytes} bytes`);
      return events;
    },
  };
}

/** Reads a WHATWG byte stream as SSE and calls onEvent for each event, in order. */
export async function readEventStream(body, onEvent, options) {
  const parser = createSSEParser(options);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) await onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}
