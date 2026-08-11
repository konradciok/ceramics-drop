export type FieldErrors = Record<string, string>;

export async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    fields?: FieldErrors;
    version?: { version: number };
    path?: string;
    token?: string;
  };
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { fields?: FieldErrors };
    err.fields = data.fields;
    throw err;
  }
  return data;
}
