/** The shapes of the structured results, shared by every server-side provider. */
import { z } from "zod";
import type { SchemaName } from "../src/llm/types";

export const schemas: Record<SchemaName, z.ZodType> = {
  cascade: z.object({ levels: z.number().int(), reason: z.string() }),
  resolve: z.object({ resolutions: z.array(z.object({ id: z.string(), text: z.string(), rationale: z.string() })) }),
  contradictions: z.object({
    contradictions: z.array(z.object({ node: z.string(), other: z.string(), explanation: z.string(), text: z.string() })),
  }),
  review: z.object({
    verdicts: z.array(
      z.object({
        id: z.string().describe("The proposal's id, as given."),
        link: z.boolean().describe("true: make the link; false: leave the words unlinked."),
        reason: z.string().describe("Why, in at most twelve words, for a person reading a list."),
      }),
    ),
  }),
};
