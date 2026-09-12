export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ code, message, requestId, ...extra }, status);
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
