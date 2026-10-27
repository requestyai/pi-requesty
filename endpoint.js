export const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
export const EU_BASE_URL = "https://router.eu.requesty.ai/v1";

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a full Requesty base URL, for example https://router.eu.requesty.ai/v1.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("The Requesty base URL must use HTTP(S), without credentials, a query, or a fragment.");
  }
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}
