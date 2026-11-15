/** The shapes of the structured results, shared by every server-side provider. */
import { z } from "zod";
import type { SchemaName } from "../src/llm/types";

export const schemas: Record<SchemaName, z.ZodType> = {
  cascade: z.object({ levels: z.number().int(), reason: z.string() }),
  resolve: z.object({ resolutions: z.array(z.object({ id: z.string(), text: z.string(), rationale: z.string() })) }),
  contradictions: z.object({
    contradictions: z.array(z.object({ node: z.string(), other: z.string(), explanation: z.string(), text: z.string() })),
  }),
};
