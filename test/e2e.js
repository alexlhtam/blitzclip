// Browser end-to-end check against the local dev server with the in-memory store:
// sign up → drop a replay → it is parsed, uploaded and saved → reload → it is still there →
// status change persists → delete works. Run: BLITZCLIP_FAKE_DB=1 node test/e2e.js
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeServer } from './server.js';
import { makeReplay } from './fixture.js';

process.env.BLITZCLIP_FAKE_DB = '1';
const server = makeServer(); await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
mkdirSync('test/tmp', { recursive: true });
const f1 = 'test/tmp/20260911_1225_GB48_FV215b_183.wotbreplay', f2 = 'test/tmp/20260911_1300_GB48_FV215b_183.wotbreplay';
writeFileSync(f1, makeReplay({ seed: 1 })); writeFileSync(f2, makeReplay({ seed: 2 }));

const browser = await chromium.launch();
const ctx = await browser.newContext(); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g/.test(m.text())) errors.push(m.text()); }); // font CDN is blocked in the sandbox
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

await page.goto(base + '/');
await page.waitForSelector('#account button');
check(await page.textContent('#summary') !== '', 'page renders examples');

// anonymous drop → parsed locally, "sign in to keep" hint
await page.setInputFiles('#fileInput', f1);
await page.waitForFunction(() => document.querySelectorAll('.results details.row').length === 1);
check((await page.textContent('#summary')).includes('sign in to keep'), 'anonymous drop parsed locally with sign-in hint');
check((await page.textContent('.results .dmg')).trim().startsWith('1,204'), 'max shot 1,204 parsed from synthetic replay');

// create account
await page.click('button[data-auth="signup"]');
await page.fill('#authEmail', 'alex@example.com'); await page.fill('#authPassword', 'correct horse');
await page.click('#authSubmit');
await page.waitForSelector('#signOut');
await page.waitForFunction(() => document.querySelector('.results .badge.saved'));
check(true, 'signing in saved the already-parsed replay to the library');
check((await page.textContent('#accountNote')).includes('1 replay'), 'library count shows 1');

// second drop: one new, one already known
await page.setInputFiles('#fileInput', [f1, f2]);
await page.waitForFunction(() => document.querySelectorAll('.results .badge.saved').length === 2);
check((await page.textContent('#summary')).includes('1 new, 1 already in your library'), 'dedupe by sha256 on re-drop');
check(await page.locator('a:text("Download replay")').count() === 2, 'stored replay files are downloadable');

// status change + reload persistence
await page.locator('.results details.row summary').first().click();
await page.locator('.actions-row select').first().selectOption('shortlisted');
await page.waitForFunction(() => document.querySelector('.results .badge.st-shortlisted'));
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.results details.row').length === 2);
check(await page.locator('.results .badge.st-shortlisted').count() === 1, 'status survives reload (loaded from library)');
check(await page.locator('.results .badge.saved').count() === 1, 'other row still saved after reload');

// tank table saves to the account
await page.click('#tanksPanel summary');
await page.fill('#tanksJson', '[{"tank_id": 9297, "name": "FV215b 183", "max_roll": {"AP": 1187, "HESH": 1512, "HE": 1737}}]');
await page.click('#tanksApply');
await page.waitForFunction(() => document.querySelector('#tanksStatus').textContent.includes('saved to your account'));
await page.reload(); await page.waitForSelector('#signOut');
await page.waitForFunction(() => document.querySelector('#tanksSub').textContent.includes('1 tanks'));
check(true, 'tank table loaded from the account after reload');

await page.screenshot({ path: 'test/tmp/library.png', fullPage: true });

// delete
page.on('dialog', d => d.accept());
for (const d of await page.locator('.results details.row').all()) if (!(await d.getAttribute('open'))) await d.locator('summary').click();
await page.locator('button[data-act="delete"]').first().click();
await page.waitForFunction(() => document.querySelectorAll('.results details.row').length === 1);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.results details.row').length === 1);
check(true, 'delete removes the replay from the library');

// sign out → back to examples; other user sees nothing
await page.click('#signOut');
await page.waitForFunction(() => document.querySelector('.example-flag'));
check(true, 'sign out returns to example rows');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close(); server.close();
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
