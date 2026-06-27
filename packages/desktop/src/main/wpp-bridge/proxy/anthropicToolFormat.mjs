import { parseToolArguments } from "./toolArguments.mjs";

export function formatAnthropicToolCall(toolCall) {
  const fn = toolCall?.function || toolCall;
  const name = fn?.name || "unknown";
  const args = parseToolArguments(fn?.arguments);
  const params = Object.entries(args)
    .map(([key, value]) => {
      const text = formatParameterValue(value);
      return `<parameter name="${escapeXmlAttribute(key)}">${encodeXmlText(text)}</parameter>`;
    })
    .join("\n");

  const invokeBody = params ? `\n${params}\n` : "\n";

  return [
    "<function_calls>",
    `<invoke name="${escapeXmlAttribute(name)}">${invokeBody}</invoke>`,
    "</function_calls>"
  ].join("\n");
}

export function looksLikeIncompleteAnthropicToolCall(text) {
  const value = String(text || "").trim();

  if (!value.includes("<invoke") && !value.includes("<function_calls")) {
    return false;
  }

  const invokeOpens = (value.match(/<invoke\b/gi) || []).length;
  const invokeCloses = (value.match(/<\/invoke>/gi) || []).length;

  if (invokeOpens > invokeCloses) {
    return true;
  }

  if (value.includes("<function_calls>") && !value.includes("</function_calls>")) {
    return true;
  }

  const paramOpens = (value.match(/<parameter\b/gi) || []).length;
  const paramCloses = (value.match(/<\/parameter>/gi) || []).length;

  return paramOpens > paramCloses;
}

function formatParameterValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function escapeXmlAttribute(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function encodeXmlText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
