export type ModelRequestLike = {
  method?: string | null
  url?: string | null
}

const DEFAULT_BASE_URL = "https://open-web-assistant-cs.wpp.ai/"

export function isWppModelRequest(request: ModelRequestLike, baseUrl = DEFAULT_BASE_URL) {
  if (String(request.method || "GET").toUpperCase() !== "POST") return false

  const requestUrl = String(request.url || "")
  const url = safeUrl(requestUrl, baseUrl)
  const host = url?.hostname || ""

  return !(
    host.includes("datadoghq") ||
    host.startsWith("dataplane.rum.") ||
    requestUrl.includes("datadoghq") ||
    requestUrl.includes("dataplane.rum.") ||
    requestUrl.includes("/v1/project/") ||
    requestUrl.includes("/v1/tools/") ||
    requestUrl.includes("/v1/oauth/")
  )
}

function safeUrl(value: string, baseUrl: string) {
  try {
    return new URL(value, baseUrl)
  } catch {
    return null
  }
}

export const MODEL_REQUEST_FILTER_SOURCE = `
(() => {
  if (window.__o1CodeShouldRecordRequest) return;
  const safeUrl = (value) => {
    try {
      return new URL(String(value || ""), typeof location === "undefined" ? "${DEFAULT_BASE_URL}" : location.href);
    } catch (_error) {
      return null;
    }
  };
  window.__o1CodeShouldRecordRequest = (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "POST") return false;
    const requestUrl = String(request?.url || "");
    const url = safeUrl(requestUrl);
    const host = url?.hostname || "";
    return !(
      host.includes("datadoghq") ||
      host.startsWith("dataplane.rum.") ||
      requestUrl.includes("datadoghq") ||
      requestUrl.includes("dataplane.rum.") ||
      requestUrl.includes("/v1/project/") ||
      requestUrl.includes("/v1/tools/") ||
      requestUrl.includes("/v1/oauth/")
    );
  };
})();
`
