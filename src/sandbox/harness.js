'use strict';
// Trusted test harness. Lives OUTSIDE the workspace and is loaded before any user code.
//  - Runs node:test in-process and records results in a closure user code cannot reach.
//  - Prints ONE result line signed with an HMAC key that is deleted from the environment
//    before user code loads, so fake "ok" lines or fake result lines printed by user code
//    are ignored by the host (they cannot carry a valid signature).
//  - Locks the event/stream plumbing and freezes assert + node:test so user code cannot
//    flip failures into passes. Combined with --frozen-intrinsics (Array.prototype etc.).
const KEY = process.env.TRYOUT_HARNESS_KEY || '';
delete process.env.TRYOUT_HARNESS_KEY;

const crypto = require('node:crypto');
const createHmac = crypto.createHmac;
const write = process.stdout.write.bind(process.stdout);
const stringify = JSON.stringify;
const BufferFrom = Buffer.from;
const { run } = require('node:test');
const { tap } = require('node:test/reporters');
const stream = require('node:stream');
const EventEmitter = require('node:events');
require('node:assert');
require('node:assert/strict');

function lock(obj, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      Object.defineProperty(obj, k, { value: obj[k], writable: false, configurable: false, enumerable: false });
    }
  }
}
lock(EventEmitter.prototype, ['emit', 'on', 'addListener', 'once', 'prependListener', 'removeListener', 'off', 'removeAllListeners']);
lock(stream.Readable.prototype, ['on', 'addListener', 'push', 'emit', 'pipe', 'resume', 'compose']);
lock(stream.Stream.prototype, ['pipe', 'on', 'emit']);
for (const m of ['node:assert', 'node:assert/strict', 'node:test', 'node:test/reporters']) Object.freeze(require(m));

const files = process.argv.slice(2);
const results = [];

function errMsg(d) {
  const e = d && d.details && d.details.error;
  if (!e) return '';
  const m = (e.cause && e.cause.message) || e.message || '';
  return `${m}`.slice(0, 300);
}

function record(d, ok) {
  if (!d || (d.details && d.details.type === 'suite')) return;
  results[results.length] = { name: `${d.name}`.slice(0, 200), ok: ok === true, skip: d.skip !== undefined && d.skip !== false ? true : d.todo !== undefined && d.todo !== false, error: ok ? '' : errMsg(d) };
}

function finish() {
  const payload = stringify({ v: 1, results });
  const sig = createHmac('sha256', KEY).update(payload).digest('hex');
  write(`\n@@TRYOUT_RESULT@@ ${BufferFrom(payload, 'utf8').toString('base64')} ${sig}\n`);
}

const s = run({ files, isolation: 'none', concurrency: false });
s.on('test:pass', (d) => record(d, true));
s.on('test:fail', (d) => record(d, false));
s.on('end', finish);
s.compose(tap).pipe(process.stdout);
