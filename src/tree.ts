// Turns a flat list of URLs into a hierarchical tree based on path segments.
// Each node represents a URL path segment; leaves are actual pages.

import type { FirecrawlLink } from "./firecrawl.js";

export interface TreeNode {
  /** Stable id used to wire up parent/child relations and Miro item lookups. */
  id: string;
  /** Display label for the node (path segment or hostname for the root). */
  label: string;
  /** Full URL if this node corresponds to a real page; undefined for synthetic intermediates. */
  url?: string;
  /** Optional page title (from Firecrawl). */
  title?: string;
  children: TreeNode[];
  /** Depth from the root (root = 0). Filled in during layout. */
  depth: number;
  /** True if this node is a synthetic "N pages" summary inserted by collapseLeaves. */
  collapsed?: boolean;
}

/**
 * Build a tree keyed by URL path. URLs from other origins are skipped so the
 * diagram stays a single coherent site map.
 */
export function buildSitemapTree(
  rootUrl: string,
  links: FirecrawlLink[],
): TreeNode {
  const root = new URL(rootUrl);
  const rootNode: TreeNode = {
    id: "root",
    label: root.hostname,
    url: root.origin + "/",
    children: [],
    depth: 0,
  };

  // Index of path -> node, so siblings with the same parent share a node.
  const index = new Map<string, TreeNode>();
  index.set("/", rootNode);

  // Sort for deterministic output (shorter paths first → parents created before children).
  const sorted = [...links].sort((a, b) => a.url.length - b.url.length);

  for (const link of sorted) {
    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      continue; // skip malformed
    }
    if (parsed.hostname !== root.hostname) continue;

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      // it's the root itself; attach the title if we have one
      rootNode.title = link.title ?? rootNode.title;
      continue;
    }

    let parentPath = "/";
    let parent = rootNode;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const currentPath = parentPath === "/" ? `/${seg}` : `${parentPath}/${seg}`;
      const isLeaf = i === segments.length - 1;

      let node = index.get(currentPath);
      if (!node) {
        node = {
          id: currentPath,
          label: decodeURIComponent(seg),
          children: [],
          depth: 0, // recomputed during layout
        };
        index.set(currentPath, node);
        parent.children.push(node);
      }
      if (isLeaf) {
        node.url = link.url;
        if (link.title) node.title = link.title;
      }

      parent = node;
      parentPath = currentPath;
    }
  }

  // Walk to assign depths.
  const assignDepth = (n: TreeNode, d: number) => {
    n.depth = d;
    for (const c of n.children) assignDepth(c, d + 1);
  };
  assignDepth(rootNode, 0);

  return rootNode;
}

export interface SiteStats {
  totalPages: number;
  totalNodes: number;
  maxDepth: number;
  topLevelSections: number;
  /** Top-level sections ranked by descendant page count, descending. */
  largestSections: Array<{ label: string; pageCount: number }>;
}

export function computeSiteStats(root: TreeNode, topN = 5): SiteStats {
  let totalPages = 0;
  let totalNodes = 0;
  let maxDepth = 0;
  const walk = (n: TreeNode) => {
    totalNodes++;
    if (n.url) totalPages++;
    if (n.depth > maxDepth) maxDepth = n.depth;
    for (const c of n.children) walk(c);
  };
  walk(root);

  const countPages = (n: TreeNode): number => {
    let c = n.url ? 1 : 0;
    for (const ch of n.children) c += countPages(ch);
    return c;
  };

  const largestSections = root.children
    .map((c) => ({ label: c.label, pageCount: countPages(c) }))
    .sort((a, b) => b.pageCount - a.pageCount)
    .slice(0, topN);

  return {
    totalPages,
    totalNodes,
    maxDepth,
    topLevelSections: root.children.length,
    largestSections,
  };
}

/**
 * Mutate the tree in place: any parent with more than `threshold` *leaf*
 * children has those leaves replaced with a single "<N> pages" summary node.
 * Non-leaf children (sub-sections) are preserved. Returns the count of
 * summary nodes inserted.
 */
export function collapseLeaves(root: TreeNode, threshold: number): number {
  let summariesAdded = 0;
  const walk = (n: TreeNode): void => {
    const leaves = n.children.filter((c) => c.children.length === 0);
    const groups = n.children.filter((c) => c.children.length > 0);
    if (leaves.length > threshold) {
      const summary: TreeNode = {
        id: `${n.id}/__collapsed__`,
        label: `${leaves.length} pages`,
        children: [],
        depth: n.depth + 1,
        collapsed: true,
      };
      n.children = [...groups, summary];
      summariesAdded++;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return summariesAdded;
}

/** Flatten the tree to a list (DFS) — handy for logging and bulk-create. */
export function flattenTree(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    // Push reversed so DFS preserves left-to-right order.
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

/**
 * Render the tree as Miro flowchart DSL. The Miro MCP `diagram_create` tool
 * handles layout — we just emit nodes (one per line) and parent→child
 * connectors. Node objects:
 *   - root  → flowchart-terminator (green, color idx 2)
 *   - leaf  → flowchart-data       (yellow, color idx 0)
 *   - inner → flowchart-process    (yellow, color idx 0)
 */
export type FlowchartDirection = "TB" | "LR" | "BT" | "RL";

export function treeToFlowchartDsl(
  root: TreeNode,
  opts: { direction?: FlowchartDirection } = {},
): string {
  const lines: string[] = [
    `graphdir ${opts.direction ?? "TB"}`,
    "palette #fff6b6 #c6dcff #adf0c7",
    "",
  ];
  const idMap = new Map<string, string>();
  let counter = 0;

  const writeNode = (n: TreeNode): void => {
    counter++;
    const dslId = `n${counter}`;
    idMap.set(n.id, dslId);
    const object =
      n === root ? "flowchart-terminator"
      : n.children.length === 0 ? "flowchart-data"
      : "flowchart-process";
    // Color: 0 = yellow (default), 1 = blue (collapsed summary), 2 = green (root).
    const color = n === root ? 2 : n.collapsed ? 1 : 0;
    lines.push(`${dslId} ${sanitizeLabel(nodeLabel(n, n === root))} ${object} ${color}`);
    for (const c of n.children) writeNode(c);
  };
  writeNode(root);

  lines.push("");
  const writeEdges = (n: TreeNode): void => {
    const src = idMap.get(n.id)!;
    for (const c of n.children) {
      lines.push(`c ${src} - ${idMap.get(c.id)!}`);
      writeEdges(c);
    }
  };
  writeEdges(root);

  return lines.join("\n");
}

function sanitizeLabel(s: string): string {
  const cleaned = s.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "(empty)";
}

/**
 * Combine the URL slug and page title into one label. Format rules:
 *   - root → just the hostname (label as-is)
 *   - no title or title ≈ slug → just the slug
 *   - otherwise → "Title (slug)"  with the title truncated to 60 chars
 */
function nodeLabel(n: TreeNode, isRoot: boolean): string {
  if (isRoot || !n.title) return n.label;
  const title = truncate(n.title.trim(), 60);
  return slugMatchesTitle(n.label, title) ? title : `${title} (${n.label})`;
}

function slugMatchesTitle(slug: string, title: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[-_\s]+/g, " ").trim();
  return norm(slug) === norm(title);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
