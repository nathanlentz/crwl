// Console app: crawl a website with Firecrawl /v2/map, build a hierarchical
// sitemap tree, and render it on a Miro board via the Miro MCP server.
//
// Usage:
//   FIRECRAWL_API_KEY=... \
//     npm run dev -- https://example.com --board <boardId> [--limit 200] [--subdomains]
//
// Miro auth runs through OAuth 2.1 on first launch (browser pops for consent).
//
// Output: prints the board URL and a tree summary to stdout.

import "dotenv/config";
import { FirecrawlClient } from "./firecrawl.js";
import { MiroMcpClient } from "./miro.js";
import {
  buildSitemapTree,
  collapseLeaves,
  computeSiteStats,
  flattenTree,
  treeToFlowchartDsl,
  type FlowchartDirection,
  type SiteStats,
  type TreeNode,
} from "./tree.js";

interface CliArgs {
  url: string;
  boardId?: string;
  limit: number;
  includeSubdomains: boolean;
  search?: string;
  collapseThreshold: number;
  direction: FlowchartDirection;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: crwl <url> --board <boardId> [options]

Options:
  --board <id>             Target Miro board id (overrides MIRO_BOARD_ID env var)
  --limit <n>              Max URLs to fetch from Firecrawl (default: 200)
  --subdomains             Include subdomains when mapping
  --search <query>         Filter URLs by topic (passed to Firecrawl's search param)
  --collapse-threshold <n> Parents with more than n leaf children get those
                           leaves collapsed into a single "<N> pages" node.
                           Use 0 to keep every leaf. Default: 5.
  --direction <dir>        Flowchart direction: TB (top-bottom), LR (left-right),
                           BT, or RL. Default: TB.

Environment variables (required):
  FIRECRAWL_API_KEY    Firecrawl API key (https://firecrawl.dev)

Optional:
  MIRO_BOARD_ID        Target board id (used if --board is not passed)
  MIRO_MCP_URL         Override the Miro MCP server URL (default: https://mcp.miro.com/)

Miro auth: OAuth 2.1 — browser opens on first run, tokens cached to
~/.config/crwl/tokens.json.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const out: CliArgs = {
    url: args[0],
    limit: 200,
    includeSubdomains: false,
    collapseThreshold: 5,
    direction: "TB",
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit") out.limit = parseInt(args[++i], 10);
    else if (a === "--subdomains") out.includeSubdomains = true;
    else if (a === "--search") out.search = args[++i];
    else if (a === "--board") out.boardId = args[++i];
    else if (a === "--collapse-threshold") out.collapseThreshold = parseInt(args[++i], 10);
    else if (a === "--direction") {
      const v = args[++i];
      if (v !== "TB" && v !== "LR" && v !== "BT" && v !== "RL") {
        throw new Error(`--direction must be one of TB, LR, BT, RL (got ${v})`);
      }
      out.direction = v;
    }
    else throw new Error(`Unknown argument: ${a}`);
  }

  if (!/^https?:\/\//.test(out.url)) {
    throw new Error("URL must start with http:// or https://");
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function summarizeTree(root: TreeNode): string {
  const lines: string[] = [];
  const walk = (n: TreeNode, indent: string) => {
    const tag = n.url ? "" : " [group]";
    lines.push(`${indent}${n.label}${tag}`);
    for (const c of n.children) walk(c, indent + "  ");
  };
  walk(root, "");
  return lines.join("\n");
}

async function main() {
  const cli = parseArgs(process.argv);
  const firecrawlKey = requireEnv("FIRECRAWL_API_KEY");
  const rawBoardId = cli.boardId ?? process.env.MIRO_BOARD_ID;
  if (!rawBoardId) {
    throw new Error("Missing Miro board id. Pass --board <id> or set MIRO_BOARD_ID.");
  }
  // Tolerate users pasting the trailing slash from a board URL.
  const boardId = rawBoardId.replace(/\/+$/, "");
  const mcpUrl = process.env.MIRO_MCP_URL;

  // 1) Discover URLs via Firecrawl ------------------------------------------
  console.log(`[1/3] Mapping ${cli.url} via Firecrawl...`);
  const firecrawl = new FirecrawlClient(firecrawlKey);
  const links = await firecrawl.mapSite({
    url: cli.url,
    limit: cli.limit,
    includeSubdomains: cli.includeSubdomains,
    search: cli.search,
  });
  console.log(`      Found ${links.length} link(s).`);

  // 2) Build the tree, compute stats, optionally collapse ---------------------
  console.log(`[2/3] Building sitemap tree...`);
  const tree = buildSitemapTree(cli.url, links);
  const stats = computeSiteStats(tree);
  console.log(
    `      ${stats.totalPages} pages, ${stats.topLevelSections} top-level sections, max depth ${stats.maxDepth}.`,
  );

  let collapsedCount = 0;
  if (cli.collapseThreshold > 0) {
    collapsedCount = collapseLeaves(tree, cli.collapseThreshold);
    if (collapsedCount > 0) {
      console.log(
        `      Collapsed ${collapsedCount} leaf-heavy group(s) (threshold ${cli.collapseThreshold}).`,
      );
    }
  }

  const renderedNodes = flattenTree(tree);
  console.log("\nSitemap tree:\n" + summarizeTree(tree) + "\n");

  const dsl = treeToFlowchartDsl(tree, { direction: cli.direction });

  // 3) Render on Miro ------------------------------------------------------
  console.log(`[3/3] Connecting to Miro MCP server...`);
  const miro = new MiroMcpClient({ serverUrl: mcpUrl });
  await miro.connect();

  try {
    const hostname = new URL(cli.url).hostname;
    const title = `Sitemap — ${hostname}`;

    console.log(`      Sending flowchart (${renderedNodes.length} rendered nodes) to board ${boardId}...`);
    await miro.createFlowchart({ boardId, dsl, title });

    console.log(`      Adding summary doc...`);
    await miro.createDoc({
      boardId,
      content: renderSummaryMarkdown(cli.url, hostname, stats, {
        collapseThreshold: cli.collapseThreshold,
        collapsedCount,
        renderedNodeCount: renderedNodes.length,
      }),
      x: -1800,
      y: 0,
    });

    console.log(`\n✅ Done. View your board:`);
    console.log(`   https://miro.com/app/board/${boardId}/`);
  } finally {
    await miro.disconnect();
  }
}

function renderSummaryMarkdown(
  sourceUrl: string,
  hostname: string,
  stats: SiteStats,
  rendered: { collapseThreshold: number; collapsedCount: number; renderedNodeCount: number },
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Sitemap — ${hostname}`);
  lines.push("");
  lines.push(`**Source:** [${sourceUrl}](${sourceUrl})`);
  lines.push(`**Generated:** ${today}`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(`- **Pages crawled:** ${stats.totalPages}`);
  lines.push(`- **Top-level sections:** ${stats.topLevelSections}`);
  lines.push(`- **Max depth:** ${stats.maxDepth}`);
  lines.push(`- **Nodes in diagram:** ${rendered.renderedNodeCount}`);
  if (rendered.collapsedCount > 0) {
    lines.push(
      `- **Collapsed groups:** ${rendered.collapsedCount} (parents with more than ${rendered.collapseThreshold} leaf pages are summarized)`,
    );
  }
  if (stats.largestSections.length > 0) {
    lines.push("");
    lines.push("## Largest sections");
    lines.push("");
    stats.largestSections.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.label}** — ${s.pageCount} ${s.pageCount === 1 ? "page" : "pages"}`);
    });
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error("\n❌ Error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
