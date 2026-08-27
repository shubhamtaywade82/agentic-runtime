import { z } from "zod";

/**
 * Structural alias for Zod schemas. 
 * Prevents dual-instance `instanceof` failures and isolates the runtime 
 * from consumer Zod major version breaks (e.g., Zod 3 vs 4).
 * @public
 */
export interface Contract<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown };
  parse(v: unknown): T;
}

/**
 * Internal validation helper to bridge the structural alias to the concrete Zod instance
 * @public
 */
export function assertContract<T>(schema: z.ZodType<T>): Contract<T> {
  return schema;
}