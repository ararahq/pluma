import { getEncoding } from "js-tiktoken"
import { ContextError, type TokenBudget } from "./types.js"

export const MIN_TOKEN_BUDGET = 256

export function tokenCount(serialized: string, budget: TokenBudget): number {
  if (budget.tokenBudget < MIN_TOKEN_BUDGET) {
    throw new ContextError("PLUMA_TOKEN_BUDGET_TOO_SMALL", `tokenBudget must be at least ${MIN_TOKEN_BUDGET}`)
  }
  if (budget.tokenizer.version !== "1") throw new ContextError("PLUMA_TOKENIZER_UNSUPPORTED", "Unsupported tokenizer version")
  return getEncoding(budget.tokenizer.id).encode(serialized).length
}

export function serializeWithinBudget<T>(payload: T, budget: TokenBudget): { serialized: string; tokens: number } {
  const serialized = JSON.stringify(payload)
  const tokens = tokenCount(serialized, budget)
  if (tokens > budget.tokenBudget) {
    throw new ContextError("PLUMA_TOKEN_BUDGET_EXCEEDED", `Payload requires ${tokens} tokens; budget is ${budget.tokenBudget}`)
  }
  return { serialized, tokens }
}
