// An Error carrying an HTTP status (read by the REST layer) and a stable
// machine code (read by the MCP layer) plus optional machine-readable extras.
export function httpError(statusCode, code, message, details) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  if (details !== undefined) e.details = details;
  return e;
}
