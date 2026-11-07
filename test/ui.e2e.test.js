'use strict';
// BROWSER AUDIT — drives the real UI in headless Chrome: setup → live run → results →
// receipts → two-sided consent on a phone-sized screen. Fails on any console error or
// CSP violation. Skips if puppeteer-core / Chrome are not installed.
//   npm i --no-save puppeteer-core   (and set CHROME_PATH if Chrome is not auto-detected)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

function load() {
  for (const p of [process.env.TRYOUT_PUPPETEER_PATH, 'puppeteer-core'].filter(Boolean)) {
    try {
      return require(p);
    } catch {}
  }
  return null;
}
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const puppeteer = load();
const SHOTS = process.env.TRYOUT_SHOTS_DIR || '';

test('UI: full stage flow with zero console errors', { skip: !puppeteer || !chrome ? 'puppeteer-core or Chrome not available' : false, timeout: 180000 }, async () => {
  const S = await startServer({ TRYOUT_REHEARSAL_SPEED: '3' });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  const watch = (page, tag) => {
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(`${tag}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  };
  const shot = async (page, name, full = false) => SHOTS && page.screenshot({ path: path.join(SHOTS, name), fullPage: full });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const page = await browser.newPage();
    watch(page, 'stage');
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(S.base, { waitUntil: 'networkidle0' });

    // Setup screen
    assert.equal(await page.$$eval('#problem-list .card', (n) => n.length), 3);
    assert.equal(await page.$$eval('#candidate-list .card.selected', (n) => n.length), 3);
    assert.equal(await page.$eval('input[name="mode"][value="live"]', (n) => n.disabled), true, 'live disabled without key');
    await page.click('#problem-list .card:nth-child(3)'); // worker-500 (sorted by dir name)
    await page.type('#poster-name', 'Chris Guerrero');
    await page.type('#poster-email', 'chris@example.com');
    await shot(page, '1-setup.png');
    await page.click('#btn-start');
    await page.waitForSelector('#arena:not(.hidden)');
    assert.match(page.url(), /\?run=[a-f0-9]+/);
    await page.waitForSelector('.feed li.blocked', { timeout: 30000 });
    await shot(page, '2-running.png');
    await page.waitForFunction(() => document.querySelector('#arena-status').textContent === 'complete', { timeout: 90000 });
    await page.waitForSelector('#results:not(.hidden) .lb-row');
    await sleep(900);
    await shot(page, '3-results.png', true);

    const lb = await page.$$eval('.lb-row', (rows) => rows.map((r) => r.querySelector('.lb-name').textContent + ':' + r.querySelector('.lb-score').textContent));
    assert.equal(lb[0], 'Maya Okafor:100');
    assert.equal(await page.$$eval('.lane.lane-win', (n) => n.length), 1);
    assert.match(await page.$eval('#winner h2', (n) => n.textContent), /Maya Okafor's agent earned the intro/);
    assert.ok(!/^\s*(null|undefined|false)+\s*$/m.test(await page.evaluate(() => document.body.innerText)), 'stray null/undefined text node rendered');

    // Receipts dialog
    await page.click('.lane.lane-win .scorebox .btn');
    await page.waitForSelector('#dlg-receipts[open]');
    const rc = await page.$eval('#receipts-body', (n) => n.innerText);
    assert.ok(rc.includes('+++ b/src/handler.js'));
    assert.ok(!/^\s*(null|undefined|false)+\s*$/m.test(rc), 'stray null/undefined text node in receipts');
    await shot(page, '4-receipts.png');
    await page.click('#receipts-close');

    // Consent
    const reqBtn = await page.waitForSelector('xpath/.//button[contains(., "Request intro")]');
    await reqBtn.click();
    await page.waitForSelector('.parties');
    const candLink = await page.$eval('.party a', (a) => a.href);
    const accept = await page.waitForSelector('xpath/.//button[normalize-space(.)="Accept"]');
    await accept.click();
    await page.waitForSelector('xpath/.//div[contains(@class,"decision") and contains(., "Accepted")]');

    const phone = await browser.newPage();
    watch(phone, 'candidate');
    await phone.setViewport({ width: 400, height: 860, isMobile: true });
    await phone.goto(candLink, { waitUntil: 'networkidle0' });
    const before = await phone.evaluate(() => document.body.innerText);
    assert.ok(before.includes('Chris Guerrero wants to meet you'));
    assert.ok(!before.includes('chris@example.com'), 'poster email visible before consent');
    await shot(phone, '5-candidate.png', true);
    await (await phone.waitForSelector('xpath/.//button[contains(., "Yes, introduce us")]')).click();
    await phone.waitForSelector('xpath/.//*[contains(., "You\'re connected")]');
    assert.ok((await phone.evaluate(() => document.body.innerText)).includes('chris@example.com'));
    await shot(phone, '6-candidate-accepted.png', true);

    await page.bringToFront();
    await page.waitForSelector('.email-preview', { timeout: 10000 });
    const email = await page.$eval('.email-preview', (n) => n.textContent);
    assert.ok(email.includes('maya.okafor@example.com') && email.includes('Score: 100/100'));
    const eml = await page.$eval('xpath/.//a[contains(., "Download .eml")]', (a) => a.href);
    const emlRes = await fetch(eml);
    assert.equal(emlRes.status, 200);
    await shot(page, '7-intro-made.png', true);

    // Reload restores state from the URL
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#results:not(.hidden) .lb-row');
    assert.equal(await page.$$eval('.lb-row', (n) => n.length), 3);

    // Invalid consent token
    const bad = await browser.newPage();
    watch(bad, 'bad-token');
    await bad.goto(candLink.replace(/token=[^&]+/, 'token=nope'), { waitUntil: 'networkidle0' });
    assert.ok((await bad.evaluate(() => document.body.innerText)).includes('Link not valid'));

    const realErrors = errors.filter((e) => !/Failed to load resource: the server responded with a status of 403/.test(e));
    assert.deepEqual(realErrors, []);
  } finally {
    await browser.close();
    await S.stop();
  }
});
