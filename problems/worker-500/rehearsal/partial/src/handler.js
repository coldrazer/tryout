'use strict';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, data, extraHeaders = {}) {
  return { status, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) };
}

async function handle(request) {
  if (request.url !== '/api/signup') return json(404, { error: 'not_found' });

  const ct = request.headers['content-type'] || request.headers['Content-Type'];
  if (ct !== 'application/json') return json(415, { error: 'unsupported_media_type' });

  let payload;
  try {
    payload = JSON.parse(request.body);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (!payload.email || !EMAIL_RE.test(payload.email)) return json(422, { error: 'invalid_email' });
  return json(201, { ok: true, email: payload.email, name: payload.name || null });
}

module.exports = { handle };
