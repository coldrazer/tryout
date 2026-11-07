'use strict';
// Edge-style handler: request = { method, url, headers, body } -> { status, headers, body }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, data, extraHeaders = {}) {
  return { status, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) };
}

async function handle(request) {
  if (request.url !== '/api/signup') return json(404, { error: 'not_found' });

  if (request.headers['Content-Type'] !== 'application/json') {
    return json(415, { error: 'unsupported_media_type' });
  }

  const payload = JSON.parse(request.body);

  if (!payload.email || !EMAIL_RE.test(payload.email)) {
    return json(422, { error: 'invalid_email' });
  }

  return json(201, { ok: true, email: payload.email, name: payload.name || null });
}

module.exports = { handle };
