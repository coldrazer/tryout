'use strict';
// Tiny JSON-file persistence. Writes are atomic (tmp + rename) and serialized per file.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const queues = new Map();

function filePath(name) {
  return path.join(config.dataDir, `${name}.json`);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const prev = queues.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true });
    const tmp = `${filePath(name)}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
    await fsp.rename(tmp, filePath(name));
  });
  queues.set(
    name,
    next.catch((e) => console.warn(`[tryout] could not save ${name}.json: ${e.message}`)),
  );
  return next;
}

/** A keyed collection persisted to data/<name>.json */
class Collection {
  constructor(name) {
    this.name = name;
    this.items = new Map(Object.entries(readJson(name, {})));
  }
  get(id) {
    return this.items.get(id) || null;
  }
  all() {
    return [...this.items.values()];
  }
  async set(id, value) {
    this.items.set(id, value);
    await this.save();
    return value;
  }
  async delete(id) {
    const had = this.items.delete(id);
    if (had) await this.save();
    return had;
  }
  save() {
    return writeJson(this.name, Object.fromEntries(this.items));
  }
}

module.exports = { Collection, readJson, writeJson };
