'use strict';
// Edge-style handler: request = { method, url, headers, body } -> { status, headers, body }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, data, extraHeaders = {}) {
  return { status, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) };
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

async function handle(request) {
  try {
    if (!request || request.url !== '/api/signup') return json(404, { error: 'not_found' });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });

    const contentType = String(header(request.headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return json(415, { error: 'unsupported_media_type' });

    let payload;
    try {
      payload = JSON.parse(request.body);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'invalid_json' });

    if (typeof payload.email !== 'string' || !EMAIL_RE.test(payload.email)) return json(422, { error: 'invalid_email' });

    return json(201, { ok: true, email: payload.email, name: payload.name || null });
  } catch {
    return json(500, { error: 'internal' });
  }
}

module.exports = { handle };
