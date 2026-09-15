// What a strict tool schema may contain.
//
// The submit tool is sent with `strict: true`, which buys a guarantee worth
// having — the arguments validate against the schema, so the persistence layer
// never defends against a malformed payload. The price is that the API accepts
// only a subset of JSON Schema and rejects the rest outright:
//
//   Anthropic 400: tools.0.custom: For 'array' type, property 'maxItems' is
//   not supported
//
// That rejection is total. Every run of the agent fails, the message names a
// keyword rather than an agent, and nothing catches it until somebody presses
// the button in production — which is exactly how it reached production.
//
// So the schema is checked before it is sent. The list is empirical: keywords
// observed or expected to be refused for strict tools, not a general opinion
// about JSON Schema. Non-strict tools (Master AI's, for instance) are not
// subject to this and are deliberately not checked.
//
// The remedy is never to soften the constraint. It is to enforce it in code
// after the model answers, which is what this codebase does everywhere else:
// a limit the model is merely asked to respect is not a limit.

/** Keywords the API refuses on a strict tool schema. */
export const UNSUPPORTED_STRICT_KEYWORDS = [
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "default",
] as const;

const UNSUPPORTED = new Set<string>(UNSUPPORTED_STRICT_KEYWORDS);

/**
 * Every place an unsupported keyword appears, as a dotted path.
 *
 * Paths rather than a boolean, because "this schema is invalid" sends whoever
 * is debugging back to reading the whole thing. `properties.ideas.maxItems` is
 * the fix, stated.
 */
export function unsupportedStrictKeywords(schema: unknown, path = ""): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, i) => unsupportedStrictKeywords(item, `${path}[${i}]`));
  }
  if (!schema || typeof schema !== "object") return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    // A property legitimately NAMED "pattern" or "default" is a property, not a
    // keyword — so anything directly under `properties` is skipped as a name
    // and only descended into.
    const isPropertyName = path.endsWith("properties");
    if (!isPropertyName && UNSUPPORTED.has(key)) {
      found.push(here);
      continue;
    }
    found.push(...unsupportedStrictKeywords(value, here));
  }
  return found;
}
