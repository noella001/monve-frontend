import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function cookieFrom(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const cookie = header.split(',').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  assert.ok(cookie, `Expected ${name} cookie`);
  return cookie.split(';', 1)[0];
}

test('customer accounts persist saved shopping and shared sign-in recognizes admins', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'monve-account-test-'));
  const port = await availablePort();
  const api = `http://127.0.0.1:${port}`;
  const adminEmail = 'owner@example.test';
  const adminPassword = 'unchanged-admin-secret-2026';
  const staffEmail = 'staff@example.test';
  const staffPassword = 'future-admin-secret-2026';
  const child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      API_PORT: String(port),
      API_PUBLIC_URL: api,
      APP_ORIGINS: 'http://localhost:5173',
      PRODUCT_DATA_DIR: dataDir,
      ADMIN_EMAIL: adminEmail,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_ACCOUNTS_JSON: JSON.stringify([{ email: staffEmail, password: staffPassword }]),
      SESSION_SECRET: 'test-session-secret-with-sufficient-entropy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { logs += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const request = (route, options = {}) => fetch(`${api}${route}`, {
    ...options,
    headers: { Origin: 'http://localhost:5173', ...(options.headers || {}) },
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await request('/health/ready');
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Backend did not start. ${logs}`);

  const catalogue = await (await request('/api/products')).json();
  const product = catalogue.find(item => item.stock > 1 && item.sizes.length && item.colors.length);
  assert.ok(product, 'Test catalogue should have an in-stock piece');

  const password = 'customer-password-long-enough';
  const signup = await request('/api/account/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Customer', email: 'customer@example.test', password }),
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.headers.get('set-cookie')?.includes('HttpOnly'), true);
  const customerCookie = cookieFrom(signup, 'monve_customer_session');
  const created = await signup.json();
  assert.equal(created.customer.email, 'customer@example.test');

  const savedShopping = await request('/api/account/shopping', {
    method: 'PUT', headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cart: [{ product_id: product.id, size: product.sizes[0], color: product.colors[0].name, quantity: 1 }],
      wishlist: [product.id], expected_version: 0,
    }),
  });
  assert.equal(savedShopping.status, 200);
  assert.equal((await savedShopping.json()).cart[0].product.id, product.id);

  const mergeOptions = {
    method: 'POST', headers: { Cookie: customerCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'guest-merge-test-key' },
    body: JSON.stringify({
      cart: [{ product_id: product.id, size: product.sizes[0], color: product.colors[0].name, quantity: 1 }],
      wishlist: [product.id],
    }),
  };
  const merged = await request('/api/account/shopping/merge', mergeOptions);
  assert.equal((await merged.json()).cart[0].quantity, 2);
  const mergedRetry = await request('/api/account/shopping/merge', mergeOptions);
  assert.equal((await mergedRetry.json()).cart[0].quantity, 2);

  const guestSave = await request('/api/account/shopping', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cart: [], wishlist: [] }),
  });
  assert.equal(guestSave.status, 401);
  const duplicateSignup = await request('/api/account/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Duplicate', email: 'customer@example.test', password }),
  });
  assert.equal(duplicateSignup.status, 409);

  const blockedAdminSession = await (await request('/api/admin/session', { headers: { Cookie: customerCookie } })).json();
  assert.equal(blockedAdminSession.authenticated, false);

  const logout = await request('/api/account/logout', { method: 'POST', headers: { Cookie: customerCookie } });
  assert.equal(logout.status, 204);
  const login = await request('/api/account/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@example.test', password }),
  });
  assert.equal(login.status, 200);
  const restoredCookie = cookieFrom(login, 'monve_customer_session');
  const restored = await (await request('/api/account/session', { headers: { Cookie: restoredCookie } })).json();
  assert.equal(restored.cart[0].product.id, product.id);
  assert.equal(restored.cart[0].quantity, 2);
  assert.equal(restored.wishlist[0].id, product.id);

  const accountFile = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'));
  assert.equal(accountFile.length, 1);
  assert.notEqual(accountFile[0].password_hash, password);
  assert.equal(Object.hasOwn(accountFile[0], 'password'), false);

  for (const [email, secret] of [[adminEmail, adminPassword], [staffEmail, staffPassword]]) {
    const adminLogin = await request('/api/account/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: secret }),
    });
    assert.equal(adminLogin.status, 200);
    assert.deepEqual(await adminLogin.json(), { role: 'admin', authenticated: true });
    const adminCookie = cookieFrom(adminLogin, 'monve_admin_session');
    const adminSession = await (await request('/api/admin/session', { headers: { Cookie: adminCookie } })).json();
    assert.equal(adminSession.authenticated, true);
    const customerSession = await (await request('/api/account/session', { headers: { Cookie: adminCookie } })).json();
    assert.equal(customerSession.customer, null);
  }

  const existingAdminRoute = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  assert.equal(existingAdminRoute.status, 200);
  assert.equal((await existingAdminRoute.json()).authenticated, true);
});
