import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

const PASSED = new Response('passed through');
const AUTH = { AUTH_USER: 'clerk', AUTH_PASS: 'pä:ss' };

// Basic credentials as a browser sends them: base64 of the UTF-8 bytes.
const basic = (user, pass) =>
  'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');

function run(path, env, authorization) {
  const headers = authorization ? { Authorization: authorization } : {};
  return onRequest({
    request: new Request('https://alerts.example' + path, { headers }),
    env,
    next: async () => PASSED,
  });
}

test('everything is open when no password is configured', async () => {
  assert.equal(await run('/api/board', {}), PASSED);
  assert.equal(await run('/api/board', { AUTH_USER: 'only-user' }), PASSED);
});

test('pages and both APIs ask for the password when one is configured', async () => {
  for (const path of ['/', '/app.js', '/api/board', '/api/coram']) {
    const res = await run(path, AUTH);
    assert.equal(res.status, 401, path);
    assert.match(res.headers.get('WWW-Authenticate'), /^Basic /, path);
  }
});

test('health check, manifest, icons and service worker stay open', async () => {
  for (const path of ['/healthz', '/manifest.webmanifest', '/icons/icon-192.png', '/sw.js']) {
    assert.equal(await run(path, AUTH), PASSED, path);
  }
});

test('the right user and password (with ":" and non-ASCII) get through', async () => {
  assert.equal(await run('/api/board', AUTH, basic('clerk', 'pä:ss')), PASSED);
});

test('a wrong password or a garbled header is refused', async () => {
  assert.equal((await run('/api/board', AUTH, basic('clerk', 'wrong'))).status, 401);
  assert.equal((await run('/api/board', AUTH, 'Basic %%%')).status, 401);
  assert.equal((await run('/api/board', AUTH, 'Bearer abc')).status, 401);
});
