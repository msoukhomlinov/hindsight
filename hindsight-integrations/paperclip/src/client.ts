/**
 * Minimal Hindsight HTTP client for use inside the plugin worker.
 *
 * Uses native fetch (Node 20+). No external dependencies.
 */

export interface Memory {
  text: string;
  type?: string;
}

export interface RecallResponse {
  results: Memory[];
}

/**
 * Hindsight Cloud rejects recall queries longer than 500 tokens with HTTP 400.
 * Prose runs ~4 chars/token, so 1200 chars sits comfortably inside that on the
 * default deployment. This is a char-count approximation, not a real token
 * count — self-hosted instances with a different (or disabled) query token
 * limit can override it via the plugin's maxQueryChars config.
 */
const DEFAULT_MAX_QUERY_CHARS = 1200;

/**
 * Recall runs a reranker server-side, which under concurrent load can take
 * well over 15s end-to-end. Abort too early and the real response (including
 * genuine errors) is replaced by a bare AbortError.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly maxQueryChars: number;

  constructor(baseUrl: string, token?: string, maxQueryChars?: number) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
    this.maxQueryChars =
      maxQueryChars && maxQueryChars > 0 ? maxQueryChars : DEFAULT_MAX_QUERY_CHARS;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} from ${path}: ${text}`);
      }

      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(bankId: string, query: string, budget = "mid"): Promise<RecallResponse> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    return this.request<RecallResponse>("POST", path, {
      // Capped here rather than at the call sites so every caller — the
      // run-start recall and the hindsight_recall tool — is covered.
      query: query.slice(0, this.maxQueryChars),
      budget,
      max_tokens: 1024,
    });
  }

  async retain(
    bankId: string,
    content: string,
    documentId?: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      context: "paperclip",
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true });
  }

  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

export function formatMemories(memories: Memory[]): string {
  if (memories.length === 0) return "";
  return memories.map((m) => `- ${m.text}`).join("\n");
}
