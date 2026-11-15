'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const {
  sendEmail,
  buildLowStockEmailSubject,
  buildLowStockEmailHeader,
  buildLowStockEmailBody,
} = require('../services/emailService');

const EMOJI_REGEX = /[\p{Extended_Pictographic}\u2600-\u27BF]/u;

const ALLOWED_MONOCHROME_HEX = new Set([
  '#000000',
  '#111111',
  '#171717',
  '#262626',
  '#404040',
  '#525252',
  '#737373',
  '#A3A3A3',
  '#D4D4D4',
  '#E5E5E5',
  '#F5F5F5',
  '#FAFAFA',
  '#FFFFFF',
]);

const ALLOWED_RED_HEX = new Set([
  '#DC2626',
  '#991B1B',
  '#B91C1C',
  '#FEF2F2',
  '#FECACA',
  '#FCA5A5',
]);

test('Email Alert Low Stock: desain monokrom tanpa emoji dengan aksen merah khusus low stock', async (t) => {
  const sampleProducts = [
    {
      _id: '66e511111111111111111111',
      nama: 'Minyak Goreng Bimoli 2L',
      kodeProduk: 'SM002',
      kategori: 'Sembako',
      hargaBeli: 35000,
      hargaJual: 38000,
      stok: 0, // Habis
      satuan: 'pouch',
      stokMinimum: 5,
      deskripsi: 'Minyak kelapa sawit',
      aktif: true,
    },
    {
      _id: '66e522222222222222222222',
      nama: 'Kopi Kapal Api Mix',
      kodeProduk: 'MN005',
      kategori: 'Minuman',
      hargaBeli: 12000,
      hargaJual: 15000,
      stok: 2, // Menipis
      satuan: 'renteng',
      stokMinimum: 5,
      deskripsi: 'Kopi sachet 10s',
      aktif: true,
    },
  ];

  await t.test('Subject email tegas tanpa emoji dan membedakan status kritis stok habis', () => {
    const subjectKritis = buildLowStockEmailSubject(sampleProducts, new Date('2026-11-12T10:00:00Z'));
    assert.equal(EMOJI_REGEX.test(subjectKritis), false, `Subject masih mengandung emoji: ${subjectKritis}`);
    assert.match(subjectKritis, /^\[StockArt Kritis\]/);
    assert.match(subjectKritis, /1 Produk Habis/);
    assert.match(subjectKritis, /1 Menipis/);

    const nonKritis = [sampleProducts[1]];
    const subjectWarning = buildLowStockEmailSubject(nonKritis, new Date('2026-11-12T10:00:00Z'));
    assert.equal(EMOJI_REGEX.test(subjectWarning), false, `Subject masih mengandung emoji: ${subjectWarning}`);
    assert.match(subjectWarning, /^\[StockArt Alert\]/);
    assert.match(subjectWarning, /1 Produk Stok Menipis/);
  });

  await t.test('Header email selalu berjudul Peringatan Stok Produk Menipis + tanggal tanpa teks Waktu Deteksi', () => {
    const headerHtml = buildLowStockEmailHeader(sampleProducts, {
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
      isCritical: true,
      habisCount: 1,
      menipisCount: 1,
    });
    assert.equal(EMOJI_REGEX.test(headerHtml), false, 'Header masih mengandung emoji');
    assert.equal(/linear-gradient/i.test(headerHtml), false, 'Header tidak boleh memakai linear-gradient');
    assert.match(headerHtml, /Stockart/);
    assert.equal(/Berkah/i.test(headerHtml), false, 'Nama Toko Berkah harus diganti Stockart');
    assert.match(headerHtml, /Peringatan Stok Produk Menipis/);
    assert.equal(/Peringatan Stok Habis &amp;? Menipis/i.test(headerHtml), false);
    assert.equal(/Waktu Deteksi/i.test(headerHtml), false, 'Tulisan Waktu Deteksi harus dihilangkan');
    assert.match(headerHtml, /STATUS: STOK HABIS \(KRITIS\)/);
    assert.match(headerHtml, /Kamis, 12 November 2026, 20:55 WIB/);

    const hexMatches = headerHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper) || ALLOWED_RED_HEX.has(upper),
        `Warna tidak diizinkan di header: ${upper}`
      );
    }
  });

  await t.test('Body email bersih tanpa KPI cards, tanpa deskripsi produk, tanpa teks Kurang, dan tanpa Estimasi Pengadaan Ulang', () => {
    const bodyHtml = buildLowStockEmailBody(sampleProducts, {
      to: 'owner@test.com',
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
    });

    assert.equal(EMOJI_REGEX.test(bodyHtml), false, 'Body masih mengandung emoji');
    assert.equal(/linear-gradient/i.test(bodyHtml), false, 'Body tidak boleh memakai linear-gradient');

    // Bagian yang diminta user untuk dihilangkan
    assert.equal(/TOTAL TERDAMPAK/i.test(bodyHtml), false, 'TOTAL TERDAMPAK harus dihilangkan');
    assert.equal(/STOK HABIS \(0\)/i.test(bodyHtml), false, 'Kartu STOK HABIS harus dihilangkan');
    assert.equal(/STOK MENIPIS/i.test(bodyHtml), false, 'Kartu STOK MENIPIS harus dihilangkan');
    assert.equal(/Minyak kelapa sawit/i.test(bodyHtml), false, 'Deskripsi produk harus dihilangkan');
    assert.equal(/Kopi sachet 10s/i.test(bodyHtml), false, 'Deskripsi produk harus dihilangkan');
    assert.equal(/Kurang \d+/i.test(bodyHtml), false, 'Tulisan Kurang pada sisa stok harus dihilangkan');
    assert.equal(/Estimasi Pengadaan Ulang/i.test(bodyHtml), false, 'Bagian Estimasi Pengadaan Ulang harus dihilangkan');
    assert.equal(/Berkah/i.test(bodyHtml), false, 'Nama Toko Berkah di body harus diganti Stockart');
    assert.match(bodyHtml, /Owner Stockart/);

    // Kolom & data utama tetap tampil bersih
    assert.match(bodyHtml, /SM002/);
    assert.match(bodyHtml, /Minyak Goreng Bimoli 2L/);
    assert.match(bodyHtml, /Sembako/);
    assert.match(bodyHtml, /pouch/);
    assert.match(bodyHtml, /HABIS \(0\)/);
    assert.match(bodyHtml, /MN005/);
    assert.match(bodyHtml, /Kopi Kapal Api Mix/);
    assert.match(bodyHtml, /Minuman/);
    assert.match(bodyHtml, /renteng/);
    assert.match(bodyHtml, /MENIPIS/);
    assert.match(bodyHtml, /Rp 35\.000/);
    assert.match(bodyHtml, /owner@test\.com/);

    // Pastikan seluruh warna hex hanya monokrom atau merah penanda low stock
    const hexMatches = bodyHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    assert.ok(hexMatches.some((h) => ALLOWED_RED_HEX.has(h.toUpperCase())), 'Harus ada aksen merah untuk penanda low stock');
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper) || ALLOWED_RED_HEX.has(upper),
        `Warna di luar monokrom/merah ditemukan di body: ${upper}`
      );
    }
  });

  await t.test('Produk dengan stok aman tidak diberi penanda warna merah', () => {
    const safeItem = {
      _id: '66e533333333333333333333',
      nama: 'Beras Aman 5kg',
      kodeProduk: 'SM001',
      kategori: 'Sembako',
      hargaBeli: 60000,
      hargaJual: 65000,
      stok: 20,
      satuan: 'sak',
      stokMinimum: 5,
      aktif: true,
    };
    const bodyHtml = buildLowStockEmailBody([safeItem], {
      to: 'owner@test.com',
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
    });
    const hexMatches = bodyHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper),
        `Produk aman hanya boleh memakai warna monokrom netral, ditemukan: ${upper}`
      );
      assert.equal(
        ALLOWED_RED_HEX.has(upper),
        false,
        `Produk aman tidak boleh memakai warna merah (${upper})`
      );
    }
  });
});

test('sendEmail dual-mode: Brevo HTTP API & normalisasi AggregateError SMTP', async (t) => {
  await t.test('Mengirim lewat Brevo HTTP API saat BREVO_API_KEY diset (termasuk lampiran)', async (subtest) => {
    const prevEnv = {
      BREVO_API_KEY: process.env.BREVO_API_KEY,
      EMAIL_FROM: process.env.EMAIL_FROM,
      SMTP_USER: process.env.SMTP_USER,
      OWNER_EMAIL: process.env.OWNER_EMAIL,
    };
    process.env.BREVO_API_KEY = 'xkeysib-test-key';
    process.env.EMAIL_FROM = 'sender@stockart.local';
    process.env.OWNER_EMAIL = 'owner1@stockart.local, owner2@stockart.local';

    const calls = [];
    subtest.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ messageId: 'msg-123' }),
      };
    });

    try {
      const result = await sendEmail({
        subject: 'Tes Brevo',
        html: '<p>Halo</p>',
        attachment: {
          filename: 'laporan.pdf',
          contentBuffer: Buffer.from('pdf-bytes'),
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.from, 'sender@stockart.local');
      assert.equal(result.to, 'owner1@stockart.local, owner2@stockart.local');
      assert.equal(result.attachment, 'laporan.pdf');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(calls[0].init.headers['api-key'], 'xkeysib-test-key');

      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.sender.email, 'sender@stockart.local');
      assert.deepEqual(body.to, [
        { email: 'owner1@stockart.local' },
        { email: 'owner2@stockart.local' },
      ]);
      assert.equal(body.attachment[0].name, 'laporan.pdf');
      assert.equal(body.attachment[0].content, Buffer.from('pdf-bytes').toString('base64'));
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  await t.test('Normalisasi AggregateError dengan message kosong pada fallback SMTP', async (subtest) => {
    const prevEnv = {
      BREVO_API_KEY: process.env.BREVO_API_KEY,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      OWNER_EMAIL: process.env.OWNER_EMAIL,
    };
    delete process.env.BREVO_API_KEY;
    process.env.SMTP_USER = 'bot@stockart.local';
    process.env.SMTP_PASS = 'secretapppass';
    process.env.OWNER_EMAIL = 'owner@stockart.local';

    subtest.mock.method(tls, 'connect', () => {
      const socket = new EventEmitter();
      socket.write = () => {};
      socket.end = () => {};
      socket.destroy = () => {};
      queueMicrotask(() => {
        const innerErr = Object.assign(new Error('connect ECONNREFUSED 142.250.4.108:465'), {
          code: 'ECONNREFUSED',
        });
        socket.emit('error', new AggregateError([innerErr], ''));
      });
      return socket;
    });

    try {
      await assert.rejects(
        () => sendEmail({ subject: 'Tes', html: '<p>Tes</p>' }),
        /connect ECONNREFUSED/
      );
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
