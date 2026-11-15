'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDigestTime,
  getLastOccurrence,
  getNextOccurrence,
  isDigestDue,
} = require('../services/lowStockSchedule');

test('parseDigestTime: memvalidasi format HH:mm dan menolak format salah', () => {
  assert.deepEqual(parseDigestTime('07:00'), { hour: 7, minute: 0 });
  assert.deepEqual(parseDigestTime('23:59'), { hour: 23, minute: 59 });
  assert.deepEqual(parseDigestTime('00:15'), { hour: 0, minute: 15 });

  for (const bad of ['7:00', '24:00', '12:60', 'abc', '', null, 700]) {
    assert.throws(() => parseDigestTime(bad));
  }
});

test('getLastOccurrence & getNextOccurrence: mencakup seluruh skenario jadwal WIB', async (t) => {
  await t.test('1. frequency off mengembalikan null', () => {
    const settings = { digestFrequency: 'off', digestTime: '07:00' };
    const now = new Date('2026-11-16T00:00:00Z');
    assert.equal(getLastOccurrence(settings, now), null);
    assert.equal(getNextOccurrence(settings, now), null);
    assert.deepEqual(isDigestDue(settings, now), { due: false, occurrence: null });
  });

  await t.test('2. daily 07:00 WIB saat now 06:59 WIB -> slot kemarin 07:00 WIB', () => {
    const settings = { digestFrequency: 'daily', digestTime: '07:00' };
    // 16 Nov 2026 06:59 WIB = 15 Nov 2026 23:59 UTC
    const now = new Date('2026-11-15T23:59:00Z');
    const last = getLastOccurrence(settings, now);
    // 15 Nov 2026 07:00 WIB = 15 Nov 2026 00:00 UTC
    assert.equal(last.toISOString(), '2026-11-15T00:00:00.000Z');
    assert.equal(getNextOccurrence(settings, now).toISOString(), '2026-11-16T00:00:00.000Z');
  });

  await t.test('3. daily 07:00 WIB saat now tepat 07:00 WIB -> slot hari ini', () => {
    const settings = { digestFrequency: 'daily', digestTime: '07:00' };
    const now = new Date('2026-11-16T00:00:00Z');
    assert.equal(getLastOccurrence(settings, now).toISOString(), '2026-11-16T00:00:00.000Z');
  });

  await t.test('4. batas hari WIB vs UTC: daily 00:15 WIB saat 17:30Z (00:30 WIB besoknya)', () => {
    const settings = { digestFrequency: 'daily', digestTime: '00:15' };
    // 2026-11-15T17:30:00Z = 16 Nov 2026 00:30 WIB
    const now = new Date('2026-11-15T17:30:00Z');
    // Slot 16 Nov 2026 00:15 WIB = 2026-11-15T17:15:00Z
    assert.equal(getLastOccurrence(settings, now).toISOString(), '2026-11-15T17:15:00.000Z');
    assert.equal(getNextOccurrence(settings, now).toISOString(), '2026-11-16T17:15:00.000Z');
  });

  await t.test('5. weekly Senin (1) 07:00 WIB saat now Minggu -> Senin minggu lalu', () => {
    const settings = { digestFrequency: 'weekly', digestWeekday: 1, digestTime: '07:00' };
    // Minggu 15 Nov 2026 10:00 WIB = 2026-11-15T03:00:00Z
    const sunday = new Date('2026-11-15T03:00:00Z');
    // Senin 9 Nov 2026 07:00 WIB = 2026-11-09T00:00:00Z
    assert.equal(getLastOccurrence(settings, sunday).toISOString(), '2026-11-09T00:00:00.000Z');
    // Next = Senin 16 Nov 2026 07:00 WIB = 2026-11-16T00:00:00Z
    assert.equal(getNextOccurrence(settings, sunday).toISOString(), '2026-11-16T00:00:00.000Z');

    // Senin 16 Nov 2026 06:59 WIB -> masih Senin 9 Nov 2026 07:00 WIB
    const monBefore = new Date('2026-11-15T23:59:00Z');
    assert.equal(getLastOccurrence(settings, monBefore).toISOString(), '2026-11-09T00:00:00.000Z');
    assert.equal(getNextOccurrence(settings, monBefore).toISOString(), '2026-11-16T00:00:00.000Z');
  });

  await t.test('6. monthly tanggal 1 jam 07:00 saat now 15 Nov -> 1 Nov 07:00 WIB', () => {
    const settings = { digestFrequency: 'monthly', digestDayOfMonth: 1, digestTime: '07:00' };
    const now = new Date('2026-11-15T03:00:00Z');
    assert.equal(getLastOccurrence(settings, now).toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(getNextOccurrence(settings, now).toISOString(), '2026-12-01T00:00:00.000Z');
  });

  await t.test('7. monthly tanggal 1 jam 07:00 saat now 1 Jan 06:00 WIB -> 1 Des tahun lalu', () => {
    const settings = { digestFrequency: 'monthly', digestDayOfMonth: 1, digestTime: '07:00' };
    // 1 Jan 2026 06:00 WIB = 31 Des 2025 23:00 UTC
    const now = new Date('2025-12-31T23:00:00Z');
    assert.equal(getLastOccurrence(settings, now).toISOString(), '2025-12-01T00:00:00.000Z');
    assert.equal(getNextOccurrence(settings, now).toISOString(), '2026-01-01T00:00:00.000Z');
  });

  await t.test('8. monthly tanggal 28 aman melintasi Februari', () => {
    const settings = { digestFrequency: 'monthly', digestDayOfMonth: 28, digestTime: '07:00' };
    // 15 Mar 2026 10:00 WIB -> slot terakhir 28 Feb 2026 07:00 WIB
    const march = new Date('2026-03-15T03:00:00Z');
    assert.equal(getLastOccurrence(settings, march).toISOString(), '2026-02-28T00:00:00.000Z');

    // 28 Feb 2026 06:30 WIB -> slot terakhir 28 Jan 2026 07:00 WIB, next 28 Feb 2026
    const febBefore = new Date('2026-02-27T23:30:00Z');
    assert.equal(getLastOccurrence(settings, febBefore).toISOString(), '2026-01-28T00:00:00.000Z');
    assert.equal(getNextOccurrence(settings, febBefore).toISOString(), '2026-02-28T00:00:00.000Z');
  });

  await t.test('9. getNextOccurrence tepat di waktu slot mengembalikan slot berikutnya', () => {
    const daily = { digestFrequency: 'daily', digestTime: '07:00' };
    assert.equal(
      getNextOccurrence(daily, new Date('2026-11-16T00:00:00Z')).toISOString(),
      '2026-11-17T00:00:00.000Z'
    );

    const weekly = { digestFrequency: 'weekly', digestWeekday: 1, digestTime: '07:00' };
    assert.equal(
      getNextOccurrence(weekly, new Date('2026-11-16T00:00:00Z')).toISOString(),
      '2026-11-23T00:00:00.000Z'
    );

    const monthly = { digestFrequency: 'monthly', digestDayOfMonth: 1, digestTime: '07:00' };
    assert.equal(
      getNextOccurrence(monthly, new Date('2026-12-01T00:00:00Z')).toISOString(),
      '2027-01-01T00:00:00.000Z'
    );
  });
});

test('isDigestDue: aktivasi baru, catch-up setelah server mati, dan anti-duplikat', async (t) => {
  await t.test('10. aktivasi setelah slot terakhir tidak langsung due', () => {
    const settings = {
      digestFrequency: 'weekly',
      digestWeekday: 1,
      digestTime: '07:00',
      // Owner baru mengaktifkan jadwal pada Rabu 11 Nov 2026 (setelah slot Senin 9 Nov 07:00)
      scheduleActivatedAt: new Date('2026-11-11T05:00:00Z'),
      lastDigestOccurrence: null,
    };
    const now = new Date('2026-11-11T05:01:00Z');
    const res = isDigestDue(settings, now);
    assert.equal(res.due, false);
    assert.equal(res.occurrence.toISOString(), '2026-11-09T00:00:00.000Z');
  });

  await t.test('11. server mati saat slot dan bangun +1 hari tetap due (catch-up 1x)', () => {
    const settings = {
      digestFrequency: 'weekly',
      digestWeekday: 1,
      digestTime: '07:00',
      scheduleActivatedAt: new Date('2026-11-01T00:00:00Z'),
      lastDigestOccurrence: new Date('2026-11-09T00:00:00Z'),
    };
    // Jadwal Senin 16 Nov 07:00 WIB terlewat, server baru bangun Selasa 17 Nov 09:00 WIB
    const now = new Date('2026-11-17T02:00:00Z');
    const res = isDigestDue(settings, now);
    assert.equal(res.due, true);
    assert.equal(res.occurrence.toISOString(), '2026-11-16T00:00:00.000Z');
  });

  await t.test('12. lastDigestOccurrence == slot saat ini tidak due lagi', () => {
    const settings = {
      digestFrequency: 'weekly',
      digestWeekday: 1,
      digestTime: '07:00',
      scheduleActivatedAt: new Date('2026-11-01T00:00:00Z'),
      lastDigestOccurrence: new Date('2026-11-16T00:00:00Z'),
    };
    const now = new Date('2026-11-17T02:00:00Z');
    const res = isDigestDue(settings, now);
    assert.equal(res.due, false);
    assert.equal(res.occurrence.toISOString(), '2026-11-16T00:00:00.000Z');
  });
});
