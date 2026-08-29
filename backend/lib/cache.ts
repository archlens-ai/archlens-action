import { createHash } from "node:crypto";
import type { DiffFile, DiagramTypeHint } from "./llm.js";

export interface CachedDiagram {
  svgUrl: string;
  mermaidSource: string;
  diagramType: "flowchart" | "sequence";
}

export interface DiagramCache {
  get(hash: string): Promise<CachedDiagram | null>;
  put(hash: string, value: CachedDiagram): Promise<void>;
}

/**
 * Content-addressed hash of the exact input that determines the diagram.
 * If a PR gets a trivial follow-up commit (typo fix, rebase) that doesn't
 * touch any matched file's patch content, this hash is unchanged — so we
 * skip a second LLM call and re-render entirely. This is the single
 * biggest lever on per-customer LLM cost, since "push again" is the most
 * common PR event by far.
 */
export function computeDiffHash(files: DiffFile[], diagramType: DiagramTypeHint): string {
  const normalized = files
    .map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  const hash = createHash("sha256");
  hash.update(diagramType);
  hash.update(JSON.stringify(normalized));
  return hash.digest("hex");
}

export class InMemoryDiagramCache implements DiagramCache {
  private store = new Map<string, CachedDiagram>();

  async get(hash: string): Promise<CachedDiagram | null> {
    return this.store.get(hash) ?? null;
  }

  async put(hash: string, value: CachedDiagram): Promise<void> {
    this.store.set(hash, value);
  }
}

export interface SupabaseLike {
  from(table: string): {
    select: (...args: any[]) => any;
    upsert: (...args: any[]) => any;
  };
}

/**
 * Production cache backed by a Supabase table (metadata: hash, svg_url,
 * mermaid_source, diagram_type, created_at). The SVG bytes themselves live
 * in Supabase Storage (public bucket) — this table just indexes them by
 * content hash, and rendering (see lib/mermaid.ts) only ever needs to
 * happen once per unique diff.
 */
export function createSupabaseDiagramCache(client: SupabaseLike): DiagramCache {
  return {
    async get(hash: string): Promise<CachedDiagram | null> {
      const { data, error } = await client
        .from("diagram_cache")
        .select("svg_url, mermaid_source, diagram_type")
        .eq("hash", hash)
        .maybeSingle();

      if (error || !data) return null;
      return {
        svgUrl: data.svg_url,
        mermaidSource: data.mermaid_source,
        diagramType: data.diagram_type,
      };
    },

    async put(hash: string, value: CachedDiagram): Promise<void> {
      await client.from("diagram_cache").upsert({
        hash,
        svg_url: value.svgUrl,
        mermaid_source: value.mermaidSource,
        diagram_type: value.diagramType,
        created_at: new Date().toISOString(),
      });
    },
  };
}
