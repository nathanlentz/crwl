# crwl

A Node.js/TypeScript console app that **crawls a website with Firecrawl** and renders an **AI-generated sitemap tree diagram on a Miro board** via the **Miro MCP server**.

```
+--------+    Firecrawl /v2/map    +-------------+    Miro MCP (HTTP)    +----------+
| CLI    | ----------------------> | URL → Tree  | --------------------> | Miro     |
| (this) | <---------------------- | builder     | <-------------------- | board    |
+--------+                         +-------------+                       +----------+
```

## What it does

1. Calls **Firecrawl's `/v2/map`** to discover every URL on the target site (sitemap + search index + crawl combined — fast, usually a few seconds).
2. Parses the URLs into a **hierarchical tree** based on path segments (e.g. `/blog/post-1` becomes `blog → post-1`).
3. Lays out the tree on a 2D canvas (columns = depth, rows = leaves).
4. Connects to the **Miro MCP server** over Streamable HTTP and:
   - creates **shapes** for internal/section nodes (rounded rectangles),
   - creates **sticky notes** for leaf pages,
   - draws **connectors** from each parent to its children.

The output is a clean parent → child sitemap diagram on your Miro board.

## Prerequisites

- Node.js 20+
- A Firecrawl API key — https://firecrawl.dev
- A Miro account with at least one board you can write to. **No pre-issued token needed** — auth runs through OAuth 2.1 on first launch (see below).

## Install

```bash
npm install
cp .env.example .env
# edit .env with your keys
```

## Run

```bash
# dev (no build step, uses tsx)
npm run dev -- https://example.com --board uXjVK...

# with options
npm run dev -- https://example.com --board uXjVK... --limit 100 --subdomains

# focused on a topic (Firecrawl's search filter)
npm run dev -- https://docs.example.com --board uXjVK... --search "authentication"

# production build
npm run build
npm start -- https://example.com --board uXjVK...
```

`--board` can be omitted if `MIRO_BOARD_ID` is set in `.env`; the CLI flag wins when both are present.

### CLI options

| Flag           | Description                                              | Default              |
|----------------|----------------------------------------------------------|----------------------|
| `--board <id>` | Target Miro board id                                     | `MIRO_BOARD_ID` env  |
| `--limit <n>`  | Max URLs to fetch from Firecrawl                         | `200`                |
| `--subdomains` | Include subdomains in the map                            | off                  |
| `--search <q>` | Filter URLs by topic (Firecrawl's `search` parameter)    | none                 |

## How the MCP integration works

The app uses the official `@modelcontextprotocol/sdk` package and `StreamableHTTPClientTransport` to talk to the Miro MCP server at `https://mcp.miro.com/` (overridable via `MIRO_MCP_URL`). It calls these MCP tools:

- `create_shape_item` — for parent/section nodes
- `create_sticky_note_item` — for leaf pages
- `create_connector` — for parent → child edges

Tool names are resolved at runtime via `listTools()` with fallbacks, so the app also works against community Miro MCP servers that use slightly different naming.

### Auth (OAuth 2.1, dynamic client registration)

Miro's MCP server requires OAuth 2.1 — a static `Authorization: Bearer` token won't work. On first run the CLI:

1. Registers itself as a public client with Miro (RFC 7591 dynamic client registration).
2. Starts a one-shot loopback HTTP server on `127.0.0.1:53682`.
3. Opens your browser to Miro's consent page.
4. Captures the auth code on the loopback callback and exchanges it for tokens.
5. Caches the registered client + tokens at `~/.config/crwl/tokens.json` (mode `0600`).

Subsequent runs reuse the cache; the SDK refreshes the access token transparently via the cached refresh token. To force a re-auth, delete that file.

## Project layout

```
src/
  index.ts       Entry point + CLI parser
  firecrawl.ts   Wrapper around Firecrawl /v2/map
  miro.ts        Miro MCP client (shapes, sticky notes, connectors)
  auth.ts        OAuth 2.1 provider + loopback callback for Miro MCP
  tree.ts        URL list → tree → 2D layout
```

## Notes / limits

- Firecrawl `/v2/map` is fast but may not catch dynamically-rendered links. Bump `--limit` (max 5000) if you're missing pages.
- Miro rate-limits writes; for very large sites (>500 nodes) consider chunking or using Miro's bulk-create endpoints.
- Connectors require both endpoints to already exist on the board, so the app creates items BFS-first, then wires up edges in a second pass.
