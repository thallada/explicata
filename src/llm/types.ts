/** The seam between the app and a model. Three shapes of call cover everything the app asks for. */
import type { Research, WebReport, WebStep } from "./web";
export type { Research, WebReport, WebStep };

export type Effort = "low" | "medium" | "high";

export interface Req {
  /** Which job this is (expand, deepen, regen-up, …). Only the mock provider reads it. */
  task: string;
  /** Stable instructions. Cached. */
  system: string;
  /** The document as context. Stable between edits, so cached. */
  context: string;
  /** The request itself. Changes every time, so it comes last. */
  prompt: string;
  /** Structured inputs, for the mock provider. */
  vars?: Record<string, string>;
  effort?: Effort;
  maxTokens?: number;
}

export type SchemaName = "cascade" | "resolve" | "contradictions" | "review";

export interface JsonReq extends Req {
  schema: SchemaName;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
/** Content blocks are passed back to the API untouched, so unknown kinds (thinking) ride along. */
export type Block = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };

export interface Turn {
  content: Block[];
  stop_reason: string | null;
  /**
   * What the turn did on the web, for a provider whose content does not carry it as server tool
   * blocks (the subscription route). Without it, it is read from the content (src/llm/web.ts).
   */
  web?: WebReport;
}

export interface TurnReq {
  system: string;
  context: string;
  /** Anthropic-format messages, alternating user and assistant. */
  messages: { role: "user" | "assistant"; content: string | unknown[] }[];
  vars?: Record<string, string>;
  /** Web search and fetch for this turn, within the run's caps. Absent: no web tools at all. */
  research?: Research;
}

export interface LLM {
  /** claude: a real model. mock: deterministic stand-in for tests. off: no credentials. */
  kind: "claude" | "mock" | "off";
  model?: string;
  stream(req: Req, onText: (delta: string) => void, signal?: AbortSignal): Promise<string>;
  json<T>(req: JsonReq, signal?: AbortSignal): Promise<T>;
  /** One agent turn. `onWeb` hears each search and page read as it happens, where the provider can tell. */
  turn(req: TurnReq, signal?: AbortSignal, onWeb?: (step: WebStep) => void): Promise<Turn>;
}

export class LLMUnavailable extends Error {
  constructor() {
    super("No model is configured. Start the server with CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY set to generate new expansions.");
  }
}

// ---- structured results ----

export interface CascadeDecision {
  /** How many ancestors, nearest first, need their text rewritten. */
  levels: number;
  reason: string;
}

export interface Resolutions {
  resolutions: { id: string; text: string; rationale: string }[];
}

export interface Contradictions {
  contradictions: { node: string; other: string; explanation: string; text: string }[];
}

/** The link reviewer's verdicts (server/links/review.ts): one per proposal, by its id. */
export interface LinkVerdicts {
  verdicts: { id: string; link: boolean; reason: string }[];
}
