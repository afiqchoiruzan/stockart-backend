'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDateFilter,
  parseRevenueInterval,
  TOP_PRODUCTS_SORT,
} = require('../services/reportService');

test('buildDateFilter: rentang tanggal dihitung dari 00:00 WIB', () => {
  const filter = buildDateFilter('2026-11-10', '2026-11-16');
  // 10 Nov 2026 00:00 WIB = 9 Nov 2026 17:00 UTC
  assert.equal(filter.$gte.toISOString(), '2026-11-09T17:00:00.000Z');
  // Batas akhir eksklusif: 17 Nov 2026 00:00 WIB = 16 Nov 2026 17:00 UTC
  assert.equal(filter.$lt.toISOString(), '2026-11-16T17:00:00.000Z');
  assert.equal(filter.$lte, undefined);
});

test('buildDateFilter: transaksi dini hari WIB masuk ke tanggal WIB yang benar', () => {
  const filter = buildDateFilter('2026-11-16', '2026-11-16');
  // 16 Nov 2026 01:00 WIB = 15 Nov 2026 18:00 UTC -> termasuk 16 Nov
  const diniHari = new Date('2026-11-15T18:00:00Z');
  assert.ok(diniHari >= filter.$gte && diniHari < filter.$lt);
  // 16 Nov 2026 23:30 WIB = 16 Nov 2026 16:30 UTC -> termasuk 16 Nov
  const malam = new Date('2026-11-16T16:30:00Z');
  assert.ok(malam >= filter.$gte && malam < filter.$lt);
  // 17 Nov 2026 00:30 WIB = 16 Nov 2026 17:30 UTC -> sudah hari berikutnya
  const besok = new Date('2026-11-16T17:30:00Z');
  assert.ok(!(besok < filter.$lt));
});

test('buildDateFilter: hanya salah satu tanggal atau tanpa tanggal', () => {
  assert.deepEqual(buildDateFilter(), {});
  assert.deepEqual(Object.keys(buildDateFilter('2026-11-10')), ['$gte']);
  assert.deepEqual(Object.keys(buildDateFilter(undefined, '2026-11-16')), ['$lt']);
});

test('buildDateFilter: menolak format tanggal dan rentang tidak valid', () => {
  for (const [mulai, akhir] of [
    ['2026-02-30', undefined],
    ['16-11-2026', undefined],
    [undefined, '2026/11/16'],
    [['2026-11-16'], undefined],
    ['2026-11-17', '2026-11-16'],
  ]) {
    assert.throws(() => buildDateFilter(mulai, akhir), { statusCode: 400 });
  }
});

test('parseRevenueInterval: default hari, menerima jam, menolak nilai lain', () => {
  assert.equal(parseRevenueInterval(undefined), 'hari');
  assert.equal(parseRevenueInterval(''), 'hari');
  assert.equal(parseRevenueInterval('hari'), 'hari');
  assert.equal(parseRevenueInterval('jam'), 'jam');
  for (const bad of ['minggu', 'JAM', ['jam']]) {
    assert.throws(() => parseRevenueInterval(bad), { statusCode: 400 });
  }
});

test('TOP_PRODUCTS_SORT: urutan stabil saat jumlah terjual seri', () => {
  assert.deepEqual(Object.keys(TOP_PRODUCTS_SORT), ['totalTerjual', 'totalPendapatan', '_id']);
  assert.deepEqual(Object.values(TOP_PRODUCTS_SORT), [-1, -1, 1]);
});
