/**
 * OAuth for remote MCP servers — the browser-redirect flow.
 *
 * Many hosted MCP servers issue no long-lived token at all; the only way in is
 * an authorization-code flow with PKCE. That means we need three things a CLI
 * does not normally have: a redirect target, a browser, and somewhere to keep
 * the tokens.
 *
 * The redirect target is a throwaway loopback server on a FIXED port — fixed
 * because `redirect_uri` must match what was registered, so it cannot drift
 * between runs. Tokens live in ~/.config/ensemble/auth.json with 0600
 * permissions; nothing is ever written into the project.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Must be stable across runs: it is baked into the registered redirect_uri. */
export const CALLBACK_PORT = Number(process.env["ENSEMBLE_OAUTH_PORT"] ?? 8976);
const CALLBACK_PATH = "/callback";

function authFile(): string {
  return join(homedir(), ".config", "ensemble", "auth.json");
}

interface StoredAuth {
  [server: string]: {
    tokens?: OAuthTokens;
    client?: OAuthClientInformationFull;
    codeVerifier?: string;
  };
}

function readAuth(): StoredAuth {
  const file = authFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredAuth;
  } catch {
    return {};
  }
}

function writeAuth(data: StoredAuth): void {
  const file = authFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  // These are live credentials — keep them owner-only.
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
}

/** True when we already hold a token for this server (no browser needed). */
export function hasStoredTokens(server: string): boolean {
  return Boolean(readAuth()[server]?.tokens?.access_token);
}

export function forgetTokens(server: string): boolean {
  const data = readAuth();
  if (!data[server]) return false;
  delete data[server];
  writeAuth(data);
  return true;
}

export function listAuthorized(): string[] {
  return Object.entries(readAuth())
    .filter(([, v]) => v.tokens?.access_token)
    .map(([k]) => k);
}

function openBrowser(url: string): void {
  // Headless/CI/remote-shell: print the URL and let the operator open it.
  if (process.env["ENSEMBLE_NO_BROWSER"]) return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed too, so a failure here is not fatal */
  }
}

/**
 * File-backed provider. One instance per server name, so two servers never
 * share tokens or a PKCE verifier.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private server: string;
  private onAuthUrl: (url: string) => void;

  constructor(server: string, onAuthUrl: (url: string) => void) {
    this.server = server;
    this.onAuthUrl = onAuthUrl;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ensemble",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return readAuth()[this.server]?.client;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    const data = readAuth();
    data[this.server] = { ...(data[this.server] ?? {}), client: info };
    writeAuth(data);
  }

  tokens(): OAuthTokens | undefined {
    return readAuth()[this.server]?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const data = readAuth();
    data[this.server] = { ...(data[this.server] ?? {}), tokens };
    writeAuth(data);
  }

  saveCodeVerifier(verifier: string): void {
    const data = readAuth();
    data[this.server] = { ...(data[this.server] ?? {}), codeVerifier: verifier };
    writeAuth(data);
  }

  codeVerifier(): string {
    const verifier = readAuth()[this.server]?.codeVerifier;
    if (!verifier) throw new Error("no PKCE code verifier stored — restart the login");
    return verifier;
  }

  redirectToAuthorization(url: URL): void {
    this.onAuthUrl(url.toString());
    openBrowser(url.toString());
  }
}

/**
 * Runs a one-shot loopback server and resolves with the authorization code.
 * Rejects on timeout so a login can never hang a run forever.
 */
export function waitForCallback(timeoutMs = 300_000): {
  code: Promise<string>;
  close: () => void;
} {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end("not found");
      return;
    }

    const error = url.searchParams.get("error");
    const authCode = url.searchParams.get("code");

    const page = (title: string, body: string, colour: string): string =>
      `<!doctype html><meta charset="utf-8"><title>ensemble</title>` +
      `<div style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:34rem;` +
      `margin:18vh auto;padding:0 1.5rem;text-align:center">` +
      `<div style="font-size:2.5rem">${colour}</div><h1 style="font-size:1.3rem">${title}</h1>` +
      `<p style="color:#666">${body}</p></div>`;

    if (error) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(page("Authorization failed", error, "✕"));
      rejectCode(new Error(`authorization failed: ${error}`));
      return;
    }
    if (!authCode) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(page("No authorization code", "The provider did not return a code.", "✕"));
      rejectCode(new Error("no authorization code in callback"));
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("Authorized", "You can close this tab and return to your terminal.", "✓"));
    resolveCode(authCode);
  });

  server.listen(CALLBACK_PORT, "127.0.0.1");
  server.on("error", (err) =>
    rejectCode(
      new Error(
        `could not listen on 127.0.0.1:${CALLBACK_PORT} (${err.message}) — ` +
          `set ENSEMBLE_OAUTH_PORT to a free port and re-register the client`,
      ),
    ),
  );

  const timer = setTimeout(() => {
    rejectCode(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser`));
    server.close();
  }, timeoutMs);

  return {
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
