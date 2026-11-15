'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = require('../app');
const User = require('../models/User');
const NotificationSetting = require('../models/NotificationSetting');

test('HTTP /api/notifications/low-stock/settings: RBAC, validasi, update parsial, & persistensi', async (t) => {
  const dbName = `t_not_${process.pid}_${Date.now().toString(36)}`;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'stockart_notif_routes_secret';
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });

  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  });

  await Promise.all([User.syncIndexes(), NotificationSetting.syncIndexes()]);

  const [owner, kasir] = await User.create([
    { nama: 'Owner Notif', username: `own_not_${Date.now()}`, password: 'x', role: 'pemilik' },
    { nama: 'Kasir Notif', username: `ksr_not_${Date.now()}`, password: 'x', role: 'kasir' },
  ]);
  const ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const kasirToken = jwt.sign({ id: kasir._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/notifications/low-stock/settings`;

  async function req(method, { token, body } = {}) {
    const headers = { Connection: 'close' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  await t.test('1. RBAC: tanpa token 401 dan kasir 403', async () => {
    assert.equal((await req('GET')).status, 401);
    assert.equal((await req('PUT', { body: { digestFrequency: 'daily' } })).status, 401);
    assert.equal((await req('GET', { token: kasirToken })).status, 403);
    assert.equal(
      (await req('PUT', { token: kasirToken, body: { digestFrequency: 'daily' } })).status,
      403
    );
  });

  let initialActivatedAt;
  await t.test('2. GET default settings sebagai pemilik mengembalikan konfigurasi default & nextRunAt', async () => {
    const res = await req('GET', { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    const data = res.json.data;
    assert.equal(data.digestFrequency, 'weekly');
    assert.equal(data.digestTime, '07:00');
    assert.equal(data.digestWeekday, 1);
    assert.equal(data.digestDayOfMonth, 1);
    assert.equal(data.criticalAlertEnabled, true);
    assert.equal(typeof data.emailConfigured, 'boolean');
    assert.ok(data.nextRunAt && !Number.isNaN(Date.parse(data.nextRunAt)));
    initialActivatedAt = data.scheduleActivatedAt;
  });

  await t.test('3. PUT menolak payload invalid (400) dengan daftar errors', async () => {
    const invalidPayloads = [
      {},
      { digestFrequency: 'yearly' },
      { digestTime: '24:00' },
      { digestWeekday: 7 },
      { digestDayOfMonth: 29 },
      { criticalAlertEnabled: 'true' },
      { fieldAsing: true },
    ];
    for (const body of invalidPayloads) {
      const res = await req('PUT', { token: ownerToken, body });
      assert.equal(res.status, 400, `Harus 400 untuk ${JSON.stringify(body)}`);
      assert.equal(res.json.success, false);
      assert.ok(Array.isArray(res.json.errors) && res.json.errors.length > 0);
    }
  });

  await t.test('4. PUT parsial memperbarui jadwal & persisten saat GET berikutnya', async () => {
    // Toggle criticalAlertEnabled saja -> scheduleActivatedAt tetap sama
    const toggleRes = await req('PUT', {
      token: ownerToken,
      body: { criticalAlertEnabled: false },
    });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.json.data.criticalAlertEnabled, false);
    assert.equal(toggleRes.json.data.scheduleActivatedAt, initialActivatedAt);

    // Update sebagian jadwal ke monthly tgl 15 jam 08:30
    const res = await req('PUT', {
      token: ownerToken,
      body: { digestFrequency: 'monthly', digestDayOfMonth: 15, digestTime: '08:30' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.digestFrequency, 'monthly');
    assert.equal(res.json.data.digestDayOfMonth, 15);
    assert.equal(res.json.data.digestTime, '08:30');
    // criticalAlertEnabled dari update sebelumnya tetap terjaga
    assert.equal(res.json.data.criticalAlertEnabled, false);
    assert.ok(res.json.data.nextRunAt);

    const fetched = await req('GET', { token: ownerToken });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.data.digestFrequency, 'monthly');
    assert.equal(fetched.json.data.digestDayOfMonth, 15);

    // Set off -> nextRunAt null
    const offRes = await req('PUT', {
      token: ownerToken,
      body: { digestFrequency: 'off' },
    });
    assert.equal(offRes.status, 200);
    assert.equal(offRes.json.data.digestFrequency, 'off');
    assert.equal(offRes.json.data.nextRunAt, null);
  });
});
