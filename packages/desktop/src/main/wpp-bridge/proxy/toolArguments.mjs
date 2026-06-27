// Coerce an OpenAI tool_call's `arguments` — a JSON string, an already-parsed object, or junk —
// into a plain args object. Shared by both tool-call renderers (anthropicToolFormat's XML,
// jsonToolFormat's JSON) so they can't drift on how arguments are coerced. Non-object/array
// values (and unparseable strings) collapse to {}.
export function parseToolArguments(argumentsValue) {
  if (typeof argumentsValue === "string") {
    if (!argumentsValue.trim()) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsValue);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return argumentsValue;
  }

  return {};
}
