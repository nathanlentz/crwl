// Wrapper around Miro's official MCP server (https://mcp.miro.com/) using the
// MCP TypeScript SDK over Streamable HTTP. Auth is OAuth 2.1 with dynamic
// client registration — see src/auth.ts.
//
// Miro's MCP doesn't expose primitive shape/connector tools; the diagram
// surface is `diagram_create`, which takes a DSL string and lays out the
// whole diagram server-side. We only call that one tool.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { FileOAuthProvider, waitForAuthCode } from "./auth.js";

export interface MiroMcpOptions {
  /** URL of the Miro MCP server. Defaults to the official remote server. */
  serverUrl?: string;
}

export class MiroMcpClient {
  private client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private readonly authProvider = new FileOAuthProvider();
  private readonly serverUrl: URL;

  constructor(opts: MiroMcpOptions = {}) {
    this.serverUrl = new URL(opts.serverUrl ?? "https://mcp.miro.com/");
    this.rebuild();
  }

  private rebuild(): void {
    this.transport = new StreamableHTTPClientTransport(this.serverUrl, {
      authProvider: this.authProvider,
    });
    this.client = new Client(
      { name: "crwl", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // SDK already kicked off the browser flow. Capture the code on our
      // loopback server, finish the exchange, then reconnect.
      const code = await waitForAuthCode();
      await this.transport.finishAuth(code);
      this.rebuild();
      await this.client.connect(this.transport);
    }
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  /**
   * Create a flowchart on the given Miro board from DSL text (see
   * `treeToFlowchartDsl`). Returns the raw tool response from Miro.
   */
  async createFlowchart(args: {
    boardId: string;
    dsl: string;
    title: string;
  }): Promise<unknown> {
    return this.callTool("diagram_create", {
      miro_url: `https://miro.com/app/board/${args.boardId}`,
      diagram_type: "flowchart",
      title: args.title,
      diagram_dsl: args.dsl,
    });
  }

  /**
   * Create a markdown-formatted doc widget on the board. Use for the summary
   * panel that sits next to the flowchart.
   */
  async createDoc(args: {
    boardId: string;
    content: string;
    x?: number;
    y?: number;
  }): Promise<unknown> {
    return this.callTool("doc_create", {
      miro_url: `https://miro.com/app/board/${args.boardId}`,
      content: args.content,
      x: args.x ?? null,
      y: args.y ?? null,
    });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(`Miro MCP ${name} failed: ${JSON.stringify(result.content)}`);
    }
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text;
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }
}
