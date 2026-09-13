/** Shared by native Anthropic requests and their context-budget reserve. */
export function anthropicMaxOutputTokens(): number {
  const value = process.env.LITESPEED_ANTHROPIC_MAX_TOKENS?.trim();
  if (!value) return 8192;
  const tokens = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(tokens) || tokens <= 0)
    throw new Error('LITESPEED_ANTHROPIC_MAX_TOKENS must be a positive whole number.');
  return tokens;
}
