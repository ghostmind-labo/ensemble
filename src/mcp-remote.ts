/**
 * Remote MCP — the same session, over the network.
 *
 * A hosted MCP server is where most tools now live, and the spec has named
 * three ways to reach one: Streamable HTTP (a POST per message, answered in
 * JSON or as an event stream), the older HTTP+SSE pair it replaced, and
 * WebSocket. Servers in the wild speak all three, so this client does, and
 * `auto` finds out which by the spec's own backwards-compatibility rule.
 *
 * Only the pipe lives here. The JSON-RPC session — ids, handshake, timeouts —
 * is `session()` in `mcp.ts`, shared with stdio, and credentials are asked of
 * the `Authorizer` in `mcp-auth.ts` on every request, so a token refreshed
 * mid-run is simply the next header sent.
 *
 * Everything is `node:http`/`node:https`, including the WebSocket handshake
 * and framing: the global WebSocket cannot carry custom headers or a client
 * certificate, and a server behind OAuth or mTLS needs both.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRaw, type IncomingMessage } from "node:http";
import { request as httpsRaw } from "node:https";
import type { Duplex } from "node:stream";
import {
  McpError,
  SessionExpired,
  session,
  type ConnectOptions,
  type McpSession,
  type RemoteServerSpec,
  type RpcMessage,
  type Transport,
} from "./mcp.ts";
import { authorizer, httpRequest, safeUrl, type Authorizer, type HttpResponse } from "./mcp-auth.ts";

const HTTP_PROTOCOL_VERSION = "2025-06-18";
const SSE_PROTOCOL_VERSION = "2024-11-05";

/** Streamable HTTP said "not me" — the auto mode's cue to try legacy SSE. */
class WrongTransport extends McpError {}

type Options = ConnectOptions & { timeoutMs: number };

export async function remote(name: string, spec: RemoteServerSpec, options: Options): Promise<McpSession> {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    throw new McpError(name, `"${spec.url}" is not a url`);
  }
  const auth = await authorizer(name, spec, options);
  const config = { timeoutMs: options.timeoutMs, signal: options.signal, redact: auth.redact };
  const mode = spec.transport ?? "auto";

  if (mode === "websocket" || (mode === "auto" && /^wss?:$/.test(url.protocol))) {
    return session(name, await websocket(name, url, auth, options), { ...config, protocolVersion: HTTP_PROTOCOL_VERSION });
  }
  if (mode === "sse") {
    return session(name, await sse(name, url, auth, options), { ...config, protocolVersion: SSE_PROTOCOL_VERSION });
  }
  try {
    return await session(name, streamable(name, url, auth, spec.listen === true), { ...config, protocolVersion: HTTP_PROTOCOL_VERSION });
  } catch (error) {
    if (mode === "auto" && error instanceof WrongTransport) {
      return session(name, await sse(name, url, auth, options), { ...config, protocolVersion: SSE_PROTOCOL_VERSION });
    }
    throw error;
  }
}

/* ──────────────────────────────── plumbing ───────────────────────────────── */

const reach = (name: string, url: URL, auth: Authorizer, error: unknown): McpError =>
  error instanceof McpError
    ? error
    : new McpError(name, auth.redact(`could not reach ${safeUrl(url)}: ${(error as Error).message}`), { cause: error });

/**
 * Send, and when the server says 401 or 403, let auth answer and send again.
 * Twice at most: a refresh, then a step-up, is the longest honest sequence.
 */
async function authed(auth: Authorizer, send: (headers: Record<string, string>) => Promise<HttpResponse>): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await send(await auth.headers());
    if ((response.status === 401 || response.status === 403) && attempt < 2) {
      const challenge = response.headers["www-authenticate"];
      response.body.resume();
      if (await auth.challenge(response.status, Array.isArray(challenge) ? challenge.join(", ") : challenge)) continue;
    }
    return response;
  }
}

/** Server-sent events, one at a time. */
export async function* events(body: IncomingMessage): AsyncGenerator<{ event: string; data: string; id?: string }> {
  body.setEncoding("utf8");
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  for await (const chunk of body) {
    buffer += chunk;
    for (let at = buffer.search(/\r\n|\r|\n/); at !== -1; at = buffer.search(/\r\n|\r|\n/)) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(buffer[at] === "\r" && buffer[at + 1] === "\n" ? at + 2 : at + 1);
      if (line === "") {
        if (data.length) yield { event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }
}

const parse = (text: string): RpcMessage[] => {
  const value = JSON.parse(text) as RpcMessage | RpcMessage[];
  return Array.isArray(value) ? value : [value];
};

const failure = async (name: string, auth: Authorizer, response: HttpResponse, what: string): Promise<McpError> => {
  const text = (await response.text().catch(() => "")).trim().slice(0, 200);
  return new McpError(name, auth.redact(`${what} returned HTTP ${response.status}${text ? `: ${text}` : ""}`));
};

/* ───────────────────────────── Streamable HTTP ───────────────────────────── */

function streamable(name: string, url: URL, auth: Authorizer, listen: boolean): Transport {
  let sessionId: string | undefined;
  let protocol: string | undefined;
  const listening = new AbortController();

  const common = (headers: Record<string, string>): Record<string, string> => ({
    ...headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(protocol ? { "mcp-protocol-version": protocol } : {}),
  });

  const pipe: Transport = {
    receive: () => {},
    broken: () => {},
    async send(message, signal) {
      const initializing = message.method === "initialize";
      if (initializing) {
        sessionId = undefined;
        protocol = undefined;
      }
      let response: HttpResponse;
      try {
        response = await authed(auth, (headers) =>
          httpRequest(auth.url(url), {
            method: "POST",
            headers: common({ ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }),
            body: JSON.stringify(message),
            tls: auth.tls,
            signal,
          }),
        );
      } catch (error) {
        throw reach(name, url, auth, error);
      }

      if (response.status === 404 && sessionId && !initializing) {
        response.body.resume();
        sessionId = undefined;
        throw new SessionExpired();
      }
      if (initializing && [400, 404, 405].includes(response.status)) {
        response.body.resume();
        throw new WrongTransport(name, `${safeUrl(url)} does not speak Streamable HTTP (HTTP ${response.status})`);
      }
      if (response.status === 202 || response.status === 204) {
        response.body.resume();
        return;
      }
      if (response.status < 200 || response.status >= 300) throw await failure(name, auth, response, safeUrl(url));

      const issued = response.headers["mcp-session-id"];
      if (initializing && typeof issued === "string") sessionId = issued;

      const type = String(response.headers["content-type"] ?? "");
      if (type.includes("text/event-stream")) {
        // Several messages may come — server requests, notifications — before ours.
        for await (const item of events(response.body)) {
          if (item.event !== "message" || !item.data) continue;
          let messages: RpcMessage[];
          try {
            messages = parse(item.data);
          } catch {
            continue;
          }
          let answered = false;
          for (const reply of messages) {
            pipe.receive(reply);
            if (message.id !== undefined && reply.id === message.id && reply.method === undefined) answered = true;
          }
          if (answered) {
            response.body.destroy();
            return;
          }
        }
        return;
      }
      const text = await response.text();
      if (!text.trim()) return;
      let messages: RpcMessage[];
      try {
        messages = parse(text);
      } catch {
        throw new McpError(name, `${safeUrl(url)} answered with something that is not JSON-RPC`);
      }
      for (const reply of messages) pipe.receive(reply);
    },
    async initialized(version) {
      protocol = version;
      if (!listen) return;
      // The optional GET stream, for messages the server starts. Best effort: 405 means "none".
      authed(auth, (headers) =>
        httpRequest(auth.url(url), { headers: common({ ...headers, accept: "text/event-stream" }), tls: auth.tls, signal: listening.signal }),
      )
        .then(async (response) => {
          if (response.status !== 200) return void response.body.resume();
          for await (const item of events(response.body)) {
            if (item.event !== "message" || !item.data) continue;
            try {
              for (const message of parse(item.data)) pipe.receive(message);
            } catch {
              /* not a message */
            }
          }
        })
        .catch(() => {});
    },
    async close() {
      listening.abort();
      if (!sessionId) return;
      const headers = await auth.headers().catch(() => ({}));
      const response = await httpRequest(auth.url(url), {
        method: "DELETE",
        headers: common(headers),
        tls: auth.tls,
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      response?.body.resume();
    },
  };
  return pipe;
}

/* ───────────────────────────── legacy HTTP+SSE ───────────────────────────── */

async function sse(name: string, url: URL, auth: Authorizer, options: Options): Promise<Transport> {
  const stream = new AbortController();
  options.signal?.addEventListener("abort", () => stream.abort(), { once: true });
  let response: HttpResponse;
  try {
    response = await authed(auth, (headers) =>
      httpRequest(auth.url(url), { headers: { ...headers, accept: "text/event-stream" }, tls: auth.tls, signal: stream.signal }),
    );
  } catch (error) {
    throw reach(name, url, auth, error);
  }
  if (response.status !== 200) throw await failure(name, auth, response, `${safeUrl(url)} (SSE)`);

  let endpoint: URL | undefined;
  const pipe: Transport = {
    receive: () => {},
    broken: () => {},
    async send(message, signal) {
      if (!endpoint) throw new McpError(name, "the SSE stream has no endpoint yet");
      let reply: HttpResponse;
      try {
        reply = await authed(auth, (headers) =>
          httpRequest(auth.url(endpoint!), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(message),
            tls: auth.tls,
            signal,
          }),
        );
      } catch (error) {
        throw reach(name, url, auth, error);
      }
      if (reply.status < 200 || reply.status >= 300) throw await failure(name, auth, reply, `${safeUrl(endpoint)} (SSE post)`);
      reply.body.resume();
    },
    close() {
      stream.abort();
    },
  };

  // The first event names where to POST; every later one is a message.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpError(name, `${safeUrl(url)} sent no endpoint event within ${options.timeoutMs}ms`)), options.timeoutMs);
    timer.unref?.();
    (async () => {
      try {
        for await (const item of events(response.body)) {
          if (item.event === "endpoint") {
            const target = new URL(item.data.trim(), url);
            // A stream that points our messages at another origin is not to be trusted with them.
            if (target.origin !== url.origin) {
              throw new McpError(name, `the SSE endpoint points at another origin (${target.host}) — refusing`);
            }
            endpoint = target;
            clearTimeout(timer);
            resolve();
          } else if (item.event === "message" && item.data) {
            try {
              for (const message of parse(item.data)) pipe.receive(message);
            } catch {
              /* not a message */
            }
          }
        }
        throw new McpError(name, "the SSE stream closed");
      } catch (error) {
        clearTimeout(timer);
        const broke = error instanceof McpError ? error : new McpError(name, auth.redact(`the SSE stream failed: ${(error as Error).message}`));
        if (!endpoint) reject(broke);
        else if (!stream.signal.aborted) pipe.broken(broke);
      }
    })();
  });
  return pipe;
}

/* ──────────────────────────────── WebSocket ──────────────────────────────── */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One client frame: FIN set, masked, as RFC 6455 requires of clients. */
function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x80 | opcode;
            b[1] = 0x80 | 127;
            b.writeBigUInt64BE(BigInt(length), 2);
            return b;
          })();
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

async function websocket(name: string, url: URL, auth: Authorizer, options: Options): Promise<Transport> {
  const target = auth.url(url);
  target.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";

  const open = (headers: Record<string, string>): Promise<{ socket: Duplex; head: Buffer } | HttpResponse> =>
    new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const send = target.protocol === "https:" ? httpsRaw : httpRaw;
      const req = send(target, {
        headers: {
          ...headers,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
          "sec-websocket-protocol": "mcp",
        },
        ...(target.protocol === "https:" ? (auth.tls ?? {}) : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      req.on("upgrade", (res, socket, head) => {
        const expected = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
        if (res.headers["sec-websocket-accept"] !== expected) {
          socket.destroy();
          reject(new McpError(name, "the WebSocket handshake was not answered correctly"));
          return;
        }
        resolve({ socket, head });
      });
      req.on("response", (res: IncomingMessage) =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          text: async () => {
            let out = "";
            res.setEncoding("utf8");
            for await (const chunk of res) out += chunk;
            return out;
          },
        }),
      );
      req.on("error", reject);
      req.end();
    });

  let opened: { socket: Duplex; head: Buffer } | undefined;
  try {
    for (let attempt = 0; !opened; attempt++) {
      const result = await open(await auth.headers());
      if ("socket" in result) opened = result;
      else if ((result.status === 401 || result.status === 403) && attempt < 2) {
        result.body.resume();
        const challenge = result.headers["www-authenticate"];
        await auth.challenge(result.status, Array.isArray(challenge) ? challenge.join(", ") : challenge);
      } else throw await failure(name, auth, result, `${safeUrl(url)} (WebSocket upgrade)`);
    }
  } catch (error) {
    throw reach(name, url, auth, error);
  }

  const { socket } = opened;
  let buffer = opened.head;
  let fragments: Buffer[] = [];
  let closed = false;

  const pipe: Transport = {
    receive: () => {},
    broken: () => {},
    async send(message) {
      if (closed) throw new McpError(name, "the WebSocket is closed");
      socket.write(frame(0x1, Buffer.from(JSON.stringify(message))));
    },
    close() {
      if (closed) return;
      closed = true;
      socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
      setTimeout(() => socket.destroy(), 1000).unref?.();
    },
  };

  const drain = (): void => {
    while (buffer.length >= 2) {
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        closed = true;
        socket.end();
        pipe.broken(new McpError(name, "the server closed the WebSocket"));
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      try {
        for (const message of parse(text)) pipe.receive(message);
      } catch {
        /* not a message */
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    pipe.broken(new McpError(name, "the WebSocket closed"));
  });
  socket.on("error", (error) => {
    if (closed) return;
    closed = true;
    pipe.broken(new McpError(name, auth.redact(`the WebSocket failed: ${error.message}`)));
  });
  // Frames that arrived with the upgrade are handled once the session has wired receive.
  queueMicrotask(drain);
  return pipe;
}
