// Thin wrapper around the Firecrawl /v2/map endpoint.
// Docs: https://docs.firecrawl.dev/api-reference/endpoint/map

export interface FirecrawlLink {
  url: string;
  title?: string;
  description?: string;
}

export interface FirecrawlMapResponse {
  success: boolean;
  links: Array<string | FirecrawlLink>;
}

export interface MapOptions {
  url: string;
  search?: string;
  sitemap?: "include" | "skip" | "only";
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  timeout?: number;
}

export class FirecrawlClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.firecrawl.dev",
  ) {
    if (!apiKey) {
      throw new Error("FIRECRAWL_API_KEY is required");
    }
  }

  async mapSite(opts: MapOptions): Promise<FirecrawlLink[]> {
    const body = {
      url: opts.url,
      sitemap: opts.sitemap ?? "include",
      includeSubdomains: opts.includeSubdomains ?? false,
      ignoreQueryParameters: opts.ignoreQueryParameters ?? true,
      limit: opts.limit ?? 500,
      timeout: opts.timeout ?? 60_000,
      ...(opts.search ? { search: opts.search } : {}),
    };

    const res = await fetch(`${this.baseUrl}/v2/map`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Firecrawl /v2/map failed: ${res.status} ${res.statusText} — ${text}`,
      );
    }

    const data = (await res.json()) as FirecrawlMapResponse;
    if (!data.success) {
      throw new Error("Firecrawl returned success=false");
    }

    // The API can return either strings or {url,title,description}; normalize.
    return data.links.map((link) =>
      typeof link === "string" ? { url: link } : link,
    );
  }
}
