// OAuth 2.1 client provider for Miro's MCP server.
//
// Miro's MCP server (https://mcp.miro.com/) authenticates via OAuth 2.1 with
// dynamic client registration. On first run we register this CLI as a client,
// open the user's browser for consent, capture the auth code on a loopback
// HTTP server, exchange it for tokens, and cache everything in
// ~/.config/crwl/tokens.json (mode 0600). Subsequent runs reuse
// the cached client + tokens; the SDK auto-refreshes via refresh_token.

import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`;

const CACHE_DIR = path.join(os.homedir(), ".config", "crwl");
const CACHE_FILE = path.join(CACHE_DIR, "tokens.json");

interface CacheFile {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf-8")) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCache(patch: Partial<CacheFile>): Promise<void> {
  const next = { ...(await readCache()), ...patch };
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CACHE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export class FileOAuthProvider implements OAuthClientProvider {
  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "crwl",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "boards:read boards:write",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return (await readCache()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await writeCache({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readCache()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await writeCache({ tokens });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await writeCache({ codeVerifier: verifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await readCache()).codeVerifier;
    if (!v) throw new Error("No PKCE code verifier saved");
    return v;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    console.log("\nOpening browser to authorize Miro access...");
    console.log("If it doesn't open, visit this URL manually:");
    console.log(`  ${authorizationUrl.toString()}\n`);
    openBrowser(authorizationUrl.toString());
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const current = await readCache();
    const next: CacheFile = { ...current };
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "verifier") delete next.codeVerifier;
    await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(CACHE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/**
 * Spin up a one-shot loopback HTTP server, wait for the OAuth provider to hit
 * /callback?code=..., resolve with the code and shut down. Times out after 5 min.
 */
export function waitForAuthCode(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server;
    const timer = setTimeout(() => {
      server?.close();
      reject(new Error("Timed out waiting for OAuth callback (5 min)"));
    }, 5 * 60_000);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end("<h1>Missing 'code' parameter</h1>");
        clearTimeout(timer);
        server.close();
        reject(new Error("OAuth callback missing 'code'"));
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          "<h1>Authorized.</h1><p>You can close this tab and return to the CLI.</p>",
        );
      clearTimeout(timer);
      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
