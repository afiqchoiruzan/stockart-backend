'use strict';

const tls = require('node:tls');
const { generateReportPdfBuffer } = require('./pdfService');

/**
 * Normalisasi error jaringan (termasuk AggregateError di Node 20+ yang message-nya kosong)
 * agar selalu memiliki pesan error yang informatif.
 */
function formatNetworkError(err) {
  if (!err) return new Error('Terjadi kesalahan jaringan yang tidak diketahui');
  if (err.message) return err;

  if (Array.isArray(err.errors) && err.errors.length > 0) {
    const details = err.errors
      .map((inner) => inner?.message || inner?.code || String(inner))
      .filter(Boolean)
      .join('; ');
    if (details) return new Error(details);
  }

  return new Error(err.code || err.name || 'Koneksi jaringan gagal');
}

const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Memecah daftar email penerima yang dipisahkan koma menjadi array alamat bersih.
 */
function parseRecipients(raw) {
  return String(raw || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

/**
 * Mengembalikan daftar email default (`OWNER_EMAIL`) terformat rapi untuk ditampilkan ke pemilik.
 */
function getDefaultRecipientLabel(env = process.env) {
  return parseRecipients(env?.OWNER_EMAIL).join(', ');
}

/**
 * Menyensor satu alamat email dengan bintang (mis. "bagas@gmail.com" -> "ba***@gmail.com").
 */
function maskEmailAddress(email) {
  const trimmed = String(email || '').trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return trimmed ? '***' : '';
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (local.length === 1) return `*@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Menyensor satu atau beberapa email (dipisah koma) dengan bintang.
 */
function maskEmailRecipients(raw) {
  return parseRecipients(raw).map(maskEmailAddress).join(', ');
}

/**
 * Memvalidasi input email opsional (mendukung kosong/null = pakai default .env,
 * satu alamat email, atau beberapa alamat dipisah koma).
 */
function validateOptionalEmailRecipients(raw) {
  if (raw === undefined || raw === null) {
    return { valid: true, normalized: undefined };
  }
  if (typeof raw !== 'string') {
    return { valid: false, message: 'email tujuan harus berupa teks' };
  }
  if (/[\r\n]/.test(raw)) {
    return { valid: false, message: 'email tujuan mengandung karakter tidak valid' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, normalized: undefined };
  }

  const recipients = parseRecipients(trimmed);
  if (recipients.length === 0 || recipients.some((item) => !SIMPLE_EMAIL_REGEX.test(item))) {
    return {
      valid: false,
      message: 'Format email tujuan tidak valid (gunakan alamat email yang benar, pisahkan koma jika lebih dari satu)',
    };
  }

  return { valid: true, normalized: recipients.join(', ') };
}

/**
 * Memeriksa apakah pengiriman email otomatis terkonfigurasi
 * melalui Brevo HTTP API (`BREVO_API_KEY`) atau fallback SMTP (`SMTP_USER` + `SMTP_PASS`).
 */
function isEmailConfigured() {
  const brevoApiKey = (process.env.BREVO_API_KEY || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  return Boolean(brevoApiKey || (smtpUser && smtpPass));
}

/**
 * Mengirim email melalui Brevo Transactional Email HTTP API (port 443 HTTPS).
 * Cocok untuk lingkungan cloud seperti Railway yang memblokir port SMTP (25/465/587).
 */
async function sendEmailViaBrevo({ apiKey, senderEmail, recipients, subject, html, attachment }) {
  const payload = {
    sender: { name: 'Stockart', email: senderEmail },
    to: recipients.map((email) => ({ email })),
    subject,
    htmlContent: html,
  };

  if (attachment && attachment.contentBuffer) {
    payload.attachment = [
      {
        name: attachment.filename,
        content: Buffer.from(attachment.contentBuffer).toString('base64'),
      },
    ];
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    let detail = rawText;
    try {
      const parsed = JSON.parse(rawText);
      detail = parsed.message || parsed.code || rawText;
    } catch {
      // gunakan rawText apa adanya
    }
    throw new Error(`Brevo API Error (${response.status}): ${detail || response.statusText}`);
  }

  return {
    success: true,
    from: senderEmail,
    to: recipients.join(', '),
    subject,
    attachment: attachment ? attachment.filename : null,
  };
}

/**
 * Mengirim email melalui Brevo HTTP API (jika BREVO_API_KEY diset)
 * atau fallback ke Gmail SMTP over SSL/TLS (port 465) menggunakan `node:tls`.
 *
 * @param {object} options
 * @param {string} [options.to]             - Email penerima (default: process.env.OWNER_EMAIL, bisa dipisah koma)
 * @param {string} options.subject          - Subjek email
 * @param {string} options.html             - Isi email dalam format HTML
 * @param {object} [options.attachment]     - Lampiran file opsional { filename, contentBuffer, contentType }
 */
function sendEmail({ to, subject, html, attachment }) {
  const brevoApiKey = (process.env.BREVO_API_KEY || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const senderEmail = (process.env.EMAIL_FROM || smtpUser).trim();
  const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const recipients = parseRecipients(to || process.env.OWNER_EMAIL);
  const recipientLabel = recipients.join(', ');

  if (brevoApiKey) {
    if (!senderEmail || recipients.length === 0) {
      return Promise.reject(
        new Error('Konfigurasi EMAIL_FROM/SMTP_USER atau OWNER_EMAIL belum lengkap di .env')
      );
    }
    return sendEmailViaBrevo({
      apiKey: brevoApiKey,
      senderEmail,
      recipients,
      subject,
      html,
      attachment,
    });
  }

  if (!smtpUser || !smtpPass || recipients.length === 0) {
    return Promise.reject(
      new Error('Konfigurasi SMTP_USER, SMTP_PASS, atau OWNER_EMAIL belum lengkap di .env')
    );
  }

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: 'smtp.gmail.com',
        port: 465,
        servername: 'smtp.gmail.com',
        timeout: 15000,
      },
      () => {}
    );

    let step = 0;
    let rcptIndex = 0;
    let buffer = '';

    const sendLine = (line) => {
      socket.write(line + '\r\n');
    };

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Koneksi ke server SMTP Gmail timeout'));
    });

    socket.on('error', (err) => {
      reject(formatNetworkError(err));
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line) continue;
        if (line.length >= 4 && line[3] === '-') continue;

        const code = parseInt(line.slice(0, 3), 10);
        if (code >= 400) {
          socket.end();
          return reject(new Error(`SMTP Error (${code}): ${line}`));
        }

        if (step === 0 && code === 220) {
          step = 1;
          sendLine('EHLO stockart-backend');
        } else if (step === 1 && code === 250) {
          step = 2;
          sendLine('AUTH LOGIN');
        } else if (step === 2 && code === 334) {
          step = 3;
          sendLine(Buffer.from(smtpUser, 'utf8').toString('base64'));
        } else if (step === 3 && code === 334) {
          step = 4;
          sendLine(Buffer.from(smtpPass, 'utf8').toString('base64'));
        } else if (step === 4 && code === 235) {
          step = 5;
          sendLine(`MAIL FROM:<${smtpUser}>`);
        } else if (step === 5 && code === 250) {
          step = 6;
          rcptIndex = 0;
          sendLine(`RCPT TO:<${recipients[rcptIndex]}>`);
        } else if (step === 6 && code === 250) {
          rcptIndex += 1;
          if (rcptIndex < recipients.length) {
            sendLine(`RCPT TO:<${recipients[rcptIndex]}>`);
          } else {
            step = 7;
            sendLine('DATA');
          }
        } else if (step === 7 && code === 354) {
          step = 8;
          const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
          const toHeader = recipients.map((email) => `<${email}>`).join(', ');
          const htmlBase64 = Buffer.from(html, 'utf8')
            .toString('base64')
            .replace(/(.{76})/g, '$1\r\n');

          let message;
          if (attachment && attachment.contentBuffer) {
            const boundary = `----=_StockartBoundary_${Date.now()}`;
            const attachBase64 = Buffer.from(attachment.contentBuffer)
              .toString('base64')
              .replace(/(.{76})/g, '$1\r\n');
            const mimeType = attachment.contentType || 'application/pdf';

            message = [
              `From: "Stockart" <${smtpUser}>`,
              `To: ${toHeader}`,
              `Subject: ${encodedSubject}`,
              'MIME-Version: 1.0',
              `Content-Type: multipart/mixed; boundary="${boundary}"`,
              '',
              `--${boundary}`,
              'Content-Type: text/html; charset=UTF-8',
              'Content-Transfer-Encoding: base64',
              '',
              htmlBase64,
              '',
              `--${boundary}`,
              `Content-Type: ${mimeType}; name="${attachment.filename}"`,
              'Content-Transfer-Encoding: base64',
              `Content-Disposition: attachment; filename="${attachment.filename}"`,
              '',
              attachBase64,
              '',
              `--${boundary}--`,
              '.',
            ].join('\r\n');
          } else {
            message = [
              `From: "Stockart" <${smtpUser}>`,
              `To: ${toHeader}`,
              `Subject: ${encodedSubject}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=UTF-8',
              'Content-Transfer-Encoding: base64',
              '',
              htmlBase64,
              '.',
            ].join('\r\n');
          }

          sendLine(message);
        } else if (step === 8 && code === 250) {
          step = 9;
          sendLine('QUIT');
          socket.end();
          resolve({
            success: true,
            from: smtpUser,
            to: recipientLabel,
            subject,
            attachment: attachment ? attachment.filename : null,
          });
        }
      }
    });
  });
}

function formatWibDate(date = new Date()) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d) + ' WIB';
}

function formatShortWibDate(date = new Date()) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

const formatRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/**
 * URL frontend untuk tautan di email (tombol Buka Halaman Laporan / Manajemen Produk).
 * Urutan: FRONTEND_URL bila diatur, lalu origin CORS_ORIGIN pertama yang bukan localhost
 * (di production CORS_ORIGIN sering juga berisi localhost untuk development),
 * terakhir fallback http://localhost:3000.
 */
function getFrontendBaseUrl(env = process.env) {
  const explicit = String(env.FRONTEND_URL || '').trim();
  const origins = String(env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const base =
    explicit ||
    origins.find((origin) => !LOCAL_ORIGIN_REGEX.test(origin)) ||
    origins[0] ||
    'http://localhost:3000';
  return base.replace(/\/+$/, '');
}

const DIGEST_FREQUENCY_LABELS = {
  daily: 'Harian',
  weekly: 'Mingguan',
  monthly: 'Bulanan',
};

function getDigestFrequencyLabel(frequency) {
  return DIGEST_FREQUENCY_LABELS[frequency] || 'Terjadwal';
}

/**
 * Membangun Subjek Email Dinamis tanpa emoji berdasarkan data produk low stock dan konteks pengiriman.
 */
function buildLowStockEmailSubject(products, now = new Date(), options = {}) {
  const items = Array.isArray(products) ? products : [];
  const { context, frequency } = options || {};
  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const dateStr = formatShortWibDate(now);

  if (context === 'digest') {
    const freqLabel = getDigestFrequencyLabel(frequency);
    if (habisCount > 0) {
      return `[Stockart Rekap ${freqLabel}] ${habisCount} Produk Habis & ${menipisCount} Menipis Perlu Restock — ${dateStr}`;
    }
    return `[Stockart Rekap ${freqLabel}] ${items.length} Produk Stok Menipis Perlu Restock — ${dateStr}`;
  }

  if (context === 'critical') {
    const firstName = items[0]?.nama || 'Produk';
    if (items.length <= 1) {
      return `[Stockart Kritis] Stok Habis: ${firstName} — ${dateStr}`;
    }
    return `[Stockart Kritis] Stok Habis: ${firstName} (+${items.length - 1} Produk Lainnya) — ${dateStr}`;
  }

  if (habisCount > 0) {
    return `[Stockart Kritis] ${habisCount} Produk Habis & ${menipisCount} Menipis Perlu Restock — ${dateStr}`;
  }
  return `[Stockart Alert] ${items.length} Produk Stok Menipis Perlu Restock — ${dateStr}`;
}

/**
 * Membangun Visual Header HTML (Monokrom tanpa emoji, dengan judul Stockart di paling atas).
 */
function buildLowStockEmailHeader(
  products,
  { wibDateTime, context, frequency }
) {
  const freqLabel = getDigestFrequencyLabel(frequency);
  let titleText = 'Peringatan Stok Produk Menipis';

  if (context === 'digest') {
    titleText = `Rekap ${freqLabel} Stok Produk Menipis`;
  } else if (context === 'critical') {
    titleText = 'Peringatan Kritis: Stok Produk Habis (0)';
  }

  return `
    <div style="background:#FFFFFF; border-top:4px solid #000000; border-bottom:1px solid #E5E5E5; padding:24px 24px 20px;">
      <div style="font-size:15px; font-weight:700; color:#000000; letter-spacing:-0.01em; margin:0 0 6px;">
        Stockart
      </div>
      <h1 style="margin:0 0 6px; font-size:22px; font-weight:700; color:#000000; letter-spacing:-0.02em; line-height:1.25;">
        ${titleText}
      </h1>
      <p style="margin:0; font-size:12px; color:#525252; line-height:1.5;">
        <strong style="color:#171717;">${wibDateTime}</strong>
      </p>
    </div>`;
}

/**
 * Membangun Body Email (Tabel Rincian Produk sesuai skema models/Product.js)
 * dengan palet monokrom bersih dan warna merah khusus untuk penanda item low stock.
 */
function buildLowStockEmailBody(products, { to, wibDateTime, context, frequency }) {
  const items = Array.isArray(products) ? [...products] : [];

  // Urutkan item dari stok terkecil (stok 0 paling atas)
  items.sort((a, b) => Number(a.stok || 0) - Number(b.stok || 0));

  const frontendBase = getFrontendBaseUrl();
  const dashboardUrl = `${frontendBase}/owner/produk`;

  const tableRows = items
    .map((p, idx) => {
      const stokNum = Number(p.stok || 0);
      const minNum = Number(p.stokMinimum ?? 0);
      const isHabis = stokNum <= 0;
      const isMenipis = !isHabis && stokNum <= minNum;
      const isLow = isHabis || isMenipis;
      const satuan = p.satuan || 'pcs';
      const kode = p.kodeProduk || `PRD-${idx + 1}`;
      const kategori = p.kategori || 'Umum';
      const hargaBeli = Number(p.hargaBeli || 0);
      const hargaJual = Number(p.hargaJual || 0);

      let statusBadge;
      if (isHabis) {
        statusBadge = '<span style="display:inline-block; padding:3px 8px; border-radius:4px; font-weight:700; font-size:10px; letter-spacing:0.03em; background:#FEF2F2; color:#991B1B; border:1px solid #DC2626;">HABIS (0)</span>';
      } else if (isMenipis) {
        statusBadge = '<span style="display:inline-block; padding:3px 8px; border-radius:4px; font-weight:700; font-size:10px; letter-spacing:0.03em; background:#FEF2F2; color:#DC2626; border:1px solid #FCA5A5;">MENIPIS</span>';
      } else {
        statusBadge = '<span style="display:inline-block; padding:3px 8px; border-radius:4px; font-weight:700; font-size:10px; letter-spacing:0.03em; background:#F5F5F5; color:#404040; border:1px solid #D4D4D4;">AMAN</span>';
      }

      const stokColor = isLow ? '#DC2626' : '#171717';
      const rowBg = idx % 2 === 0 ? '#FFFFFF' : '#FAFAFA';

      return `
        <tr style="background:${rowBg};">
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:12px; color:#525252; text-align:center; font-variant-numeric:tabular-nums;">
            ${idx + 1}
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:11px;">
            <code style="font-family:Consolas, 'Courier New', monospace; font-weight:700; color:#171717; background:#F5F5F5; border:1px solid #E5E5E5; padding:2px 6px; border-radius:4px;">${kode}</code>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:13px;">
            <strong style="color:#000000;">${p.nama}</strong>
            <div style="font-size:11px; color:#525252; margin-top:3px;">
              <span>${kategori}</span>
            </div>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:13px; text-align:center; font-variant-numeric:tabular-nums;">
            <strong style="color:${stokColor}; font-size:14px;">${stokNum}</strong>
            <span style="font-size:11px; color:#525252; margin-left:2px;">${satuan}</span>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:12px; text-align:center; color:#404040; font-variant-numeric:tabular-nums;">
            <strong>${minNum}</strong>
            <span style="font-size:11px; color:#525252; margin-left:2px;">${satuan}</span>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:12px; font-family:Consolas, monospace; color:#171717; text-align:right; font-variant-numeric:tabular-nums;">
            <div style="font-weight:700;">${formatRp(hargaBeli)}</div>
            <div style="font-size:10px; color:#525252;">Jual: ${formatRp(hargaJual)}</div>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; text-align:center;">
            ${statusBadge}
          </td>
        </tr>`;
    })
    .join('');

  const recipientLabel = to || process.env.OWNER_EMAIL;
  const freqLabel = getDigestFrequencyLabel(frequency).toLowerCase();

  let introText = `Berikut ringkasan produk aktif pada katalog <strong>Stockart</strong> yang perlu segera diperhatikan pada pengecekan <strong>${wibDateTime}</strong>:`;
  let footerText = `Notifikasi dikirim otomatis oleh server <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong> saat pengecekan stok dilakukan.`;

  if (context === 'digest') {
    introText = `Berikut rekap ${freqLabel} seluruh produk aktif pada katalog <strong>Stockart</strong> dengan stok di bawah atau sama dengan batas minimum pada <strong>${wibDateTime}</strong>:`;
    footerText = `Notifikasi rekap ${freqLabel} dikirim otomatis oleh server <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong> sesuai jadwal alert stok yang aktif.`;
  } else if (context === 'critical') {
    introText = `Produk berikut baru saja menyentuh <strong>stok 0 (habis)</strong> setelah transaksi kasir pada <strong>${wibDateTime}</strong> dan perlu segera di-restock:`;
    footerText = `Notifikasi kritis dikirim otomatis oleh server <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong> karena transaksi kasir membuat stok produk mencapai 0.`;
  } else if (context === 'manual') {
    introText = `Berikut rekap produk aktif pada katalog <strong>Stockart</strong> yang perlu segera di-restock berdasarkan pengecekan manual pada <strong>${wibDateTime}</strong>:`;
    footerText = `Notifikasi dikirim secara manual melalui dashboard <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong>.`;
  }

  return `
    <div style="padding:24px; background:#FFFFFF; color:#171717;">
      <p style="font-size:14px; margin:0 0 8px; color:#000000; line-height:1.5;">
        Halo <strong>Owner Stockart</strong>,
      </p>
      <p style="font-size:13px; line-height:1.6; color:#404040; margin:0 0 20px;">
        ${introText}
      </p>

      <!-- Tabel Rincian Produk Sesuai Skema Backend -->
      <div style="border:1px solid #D4D4D4; border-radius:6px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#F5F5F5; color:#171717; text-align:left; border-bottom:2px solid #000000;">
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center; width:36px;">No</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Kode</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Produk &amp; Kategori</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center;">Sisa Stok</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center;">Min. Stok</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:right;">Harga Beli</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>

      <!-- Action Button / CTA -->
      <div style="text-align:center; margin:24px 0 16px;">
        <a href="${dashboardUrl}" style="display:inline-block; background:#000000; color:#FFFFFF; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:13px; font-weight:700; letter-spacing:0.02em;">
          Buka Manajemen Produk &rarr;
        </a>
      </div>

      <!-- Footer Info -->
      <div style="border-top:1px solid #E5E5E5; padding-top:14px; margin-top:20px; font-size:11px; color:#525252; line-height:1.5;">
        ${footerText}
      </div>
    </div>`;
}

/**
 * Mengirim email peringatan stok menipis (Low Stock Alert) ke Email Owner.
 */
async function sendLowStockAlertEmail(products, customRecipient, options = {}) {
  const items = Array.isArray(products) ? products : [];
  if (items.length === 0) {
    return { success: false, message: 'Tidak ada produk yang perlu dilaporkan' };
  }

  const { context, frequency } = options || {};
  const now = new Date();
  const wibDateTime = formatWibDate(now);
  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const isCritical = context === 'critical' || habisCount > 0;

  const recipient = (customRecipient || process.env.OWNER_EMAIL || '').trim();
  const subject = buildLowStockEmailSubject(items, now, { context, frequency });

  const headerHtml = buildLowStockEmailHeader(items, {
    wibDateTime,
    isCritical,
    habisCount,
    menipisCount,
    context,
    frequency,
  });

  const bodyHtml = buildLowStockEmailBody(items, {
    to: recipient,
    wibDateTime,
    context,
    frequency,
  });

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Peringatan Stok Menipis Stockart</title>
</head>
<body style="margin:0; padding:20px 12px; background:#F5F5F5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width:680px; margin:0 auto; background:#FFFFFF; border:1px solid #D4D4D4; border-radius:6px; overflow:hidden;">
    ${headerHtml}
    ${bodyHtml}
  </div>
</body>
</html>`;

  return sendEmail({
    to: recipient,
    subject,
    html: fullHtml,
  });
}

const REPORT_FREQUENCY_LABELS = {
  daily: 'Harian',
  weekly: 'Mingguan',
  monthly: 'Bulanan',
};

/**
 * Mengubah label periode "YYYY-MM-DD s/d YYYY-MM-DD" menjadi format tanggal Indonesia
 * (mis. "10 Nov 2026 s/d 16 Nov 2026"). Label lain dikembalikan apa adanya.
 */
function formatReportPeriodeLabel(periodeLabel) {
  return String(periodeLabel || '').replace(/\d{4}-\d{2}-\d{2}/g, (dateKey) =>
    formatShortWibDate(new Date(`${dateKey}T00:00:00+07:00`))
  );
}

/**
 * Membangun Subjek Email Laporan tanpa emoji, mengikuti pola email rekap stok.
 */
function buildReportEmailSubject(periodeLabel, { context, frequency } = {}) {
  const periode = formatReportPeriodeLabel(periodeLabel);
  if (context === 'scheduled') {
    const freqLabel = REPORT_FREQUENCY_LABELS[frequency] || 'Terjadwal';
    return `[Stockart Laporan ${freqLabel}] Laporan Penjualan & Stok — ${periode}`;
  }
  return `[Stockart Laporan] Laporan Penjualan & Stok — ${periode}`;
}

function formatShortRp(n) {
  const value = Number(n || 0);
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace('.', ',')} jt`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} rb`;
  return String(Math.round(value));
}

/**
 * Grafik batang omzet dalam HTML berbasis tabel (aman untuk klien email dan
 * konversi PDF Google Drive), dengan data yang sama seperti grafik di PDF laporan.
 * chart: { title, points: [{ label, sublabel?, omzet }], note? }
 */
function buildReportChartHtml(chart) {
  const points = Array.isArray(chart?.points) ? chart.points : [];
  const total = points.reduce((sum, p) => sum + Number(p.omzet || 0), 0);
  const maxOmzet = Math.max(0, ...points.map((p) => Number(p.omzet || 0)));
  const plotHeight = 120;
  const showValues = points.length <= 16;

  const header = `
        <thead>
          <tr style="background:#F5F5F5; color:#171717; text-align:left; border-bottom:2px solid #000000;">
            <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">${chart?.title || 'Omzet'}</th>
            <th style="padding:10px 12px; font-size:11px; font-weight:700; letter-spacing:0.02em; text-align:right;">Total ${formatRp(total)}</th>
          </tr>
        </thead>`;

  if (points.length === 0 || maxOmzet <= 0) {
    return `
      <div style="border:1px solid #D4D4D4; border-radius:6px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">${header}
          <tbody>
            <tr><td colspan="2" style="padding:24px 12px; text-align:center; font-size:12px; color:#525252;">Belum ada omzet pada periode ini.</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  const barCells = points
    .map((point) => {
      const omzet = Number(point.omzet || 0);
      const barHeight = omzet > 0 ? Math.max(2, Math.round((omzet / maxOmzet) * plotHeight)) : 1;
      const barColor = omzet > 0 ? '#171717' : '#D4D4D4';
      const valueLabel =
        omzet > 0 && (showValues || omzet === maxOmzet)
          ? `<div style="font-size:9px; color:#525252; line-height:1.2; margin-bottom:3px; white-space:nowrap;">${formatShortRp(omzet)}</div>`
          : '';
      return `
              <td style="vertical-align:bottom; text-align:center; padding:0 2px; height:${plotHeight + 16}px;">
                ${valueLabel}
                <div style="width:70%; max-width:36px; height:${barHeight}px; line-height:${barHeight}px; font-size:1px; background:${barColor}; margin:0 auto;">&nbsp;</div>
              </td>`;
    })
    .join('');

  const labelCells = points
    .map(
      (point) => `
              <td style="vertical-align:top; text-align:center; padding:6px 2px 0; border-top:1px solid #D4D4D4;">
                <div style="font-size:10px; color:#171717; white-space:nowrap;">${point.label}</div>
                ${point.sublabel ? `<div style="font-size:9px; color:#525252; white-space:nowrap;">${point.sublabel}</div>` : ''}
              </td>`
    )
    .join('');

  const note = chart?.note
    ? `<div style="padding:0 12px 10px; font-size:10px; color:#525252;">${chart.note}</div>`
    : '';

  return `
      <div style="border:1px solid #D4D4D4; border-radius:6px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">${header}
          <tbody>
            <tr>
              <td colspan="2" style="padding:14px 12px 12px;">
                <table role="presentation" style="width:100%; border-collapse:collapse; table-layout:fixed;">
                  <tr>${barCells}
                  </tr>
                  <tr>${labelCells}
                  </tr>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
        ${note}
      </div>`;
}

/**
 * Membangun HTML Laporan Penjualan & Stok dengan gaya monokrom yang sama
 * seperti email rekap stok menipis (header Stockart, sapaan, tabel, tombol CTA).
 */
function buildReportHtml({
  periodeLabel,
  summary,
  topProducts,
  chart,
  to,
  driveInfo,
  context,
  frequency,
  generatedAt = new Date(),
}) {
  const data = summary || {};
  const items = Array.isArray(topProducts) ? topProducts : [];
  const periode = formatReportPeriodeLabel(periodeLabel);
  const wibDateTime = formatWibDate(generatedAt);
  const freqLabel = REPORT_FREQUENCY_LABELS[frequency];
  const titleText =
    context === 'scheduled' && freqLabel
      ? `Laporan ${freqLabel} Penjualan & Stok`
      : 'Laporan Penjualan & Stok';
  const recipientLabel = to || process.env.OWNER_EMAIL;

  const frontendBase = getFrontendBaseUrl();
  const reportUrl = `${frontendBase}/owner/laporan`;

  const formatUnit = (n) => Number(n || 0).toLocaleString('id-ID');

  const summaryRows = [
    ['Total Omzet', `<strong style="color:#000000; font-size:14px;">${formatRp(data.totalOmzet)}</strong>`],
    [
      data.labaEstimasi ? 'Laba Kotor <span style="font-size:11px; color:#525252;">(estimasi)</span>' : 'Laba Kotor',
      `<strong style="color:#000000; font-size:14px;">${formatRp(data.totalLaba)}</strong>`,
    ],
    ['Transaksi Selesai', `<strong style="color:#171717;">${formatUnit(data.totalTransaksi)}</strong> <span style="font-size:11px; color:#525252;">struk</span>`],
    ['Produk Terjual', `<strong style="color:#171717;">${formatUnit(data.totalTerjual)}</strong> <span style="font-size:11px; color:#525252;">unit</span>`],
    ['Barang Masuk', `<strong style="color:#171717;">${formatUnit(data.totalMasuk)}</strong> <span style="font-size:11px; color:#525252;">unit</span>`],
    ['Katalog Aktif', `<strong style="color:#171717;">${formatUnit(data.totalProduk)}</strong> <span style="font-size:11px; color:#525252;">produk</span>`],
  ]
    .map(
      ([label, value], idx) => `
        <tr style="background:${idx % 2 === 0 ? '#FFFFFF' : '#FAFAFA'};">
          <td style="padding:10px 12px; border-bottom:1px solid #E5E5E5; font-size:12px; color:#404040;">${label}</td>
          <td style="padding:10px 12px; border-bottom:1px solid #E5E5E5; font-size:13px; text-align:right; font-variant-numeric:tabular-nums;">${value}</td>
        </tr>`
    )
    .join('');

  const topRows =
    items.length > 0
      ? items
          .map((item, idx) => {
            const rowBg = idx % 2 === 0 ? '#FFFFFF' : '#FAFAFA';
            return `
        <tr style="background:${rowBg};">
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:12px; color:#525252; text-align:center; font-variant-numeric:tabular-nums;">
            ${idx + 1}
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:13px;">
            <strong style="color:#000000;">${item.namaProduk}</strong>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:13px; text-align:center; font-variant-numeric:tabular-nums;">
            <strong style="color:#171717; font-size:14px;">${formatUnit(item.totalTerjual)}</strong>
            <span style="font-size:11px; color:#525252; margin-left:2px;">unit</span>
          </td>
          <td style="padding:12px 10px; border-bottom:1px solid #E5E5E5; font-size:12px; font-family:Consolas, monospace; color:#171717; text-align:right; font-variant-numeric:tabular-nums;">
            <strong>${formatRp(item.totalPendapatan)}</strong>
          </td>
        </tr>`;
          })
          .join('')
      : `
        <tr>
          <td colspan="4" style="padding:16px 10px; text-align:center; font-size:12px; color:#525252;">
            Belum ada transaksi selesai pada periode ini.
          </td>
        </tr>`;

  const driveInfoHtml =
    driveInfo && driveInfo.uploaded
      ? `
      <div style="border:1px solid #D4D4D4; border-radius:6px; background:#FAFAFA; padding:12px 14px; margin-bottom:20px; font-size:12px; color:#404040; line-height:1.6;">
        <strong style="color:#000000;">Tersimpan di Google Drive owner</strong><br/>
        File: <a href="${driveInfo.fileUrl}" style="color:#000000; font-weight:700;">${driveInfo.fileName}</a><br/>
        Folder: <a href="${driveInfo.folderUrl}" style="color:#000000; font-weight:700;">Buka folder Stockart_Reports</a>
      </div>`
      : '';

  let introText = `Berikut laporan penjualan dan stok <strong>Stockart</strong> untuk periode <strong>${periode}</strong>:`;
  let footerText = `Laporan dikirim secara manual melalui dashboard <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong>. File PDF laporan terlampir pada email ini.`;

  if (context === 'scheduled') {
    const freqText = (freqLabel || 'terjadwal').toLowerCase();
    introText = `Berikut laporan ${freqText} penjualan dan stok <strong>Stockart</strong> untuk periode <strong>${periode}</strong>:`;
    footerText = `Laporan ${freqText} dikirim otomatis oleh server <strong style="color:#171717;">Stockart</strong> ke <strong style="color:#171717;">${recipientLabel}</strong> sesuai jadwal kirim laporan yang aktif. File PDF laporan terlampir pada email ini.`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Laporan Penjualan & Stok Stockart</title>
</head>
<body style="margin:0; padding:20px 12px; background:#F5F5F5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width:680px; margin:0 auto; background:#FFFFFF; border:1px solid #D4D4D4; border-radius:6px; overflow:hidden;">
    <div style="background:#FFFFFF; border-top:4px solid #000000; border-bottom:1px solid #E5E5E5; padding:24px 24px 20px;">
      <div style="font-size:15px; font-weight:700; color:#000000; letter-spacing:-0.01em; margin:0 0 6px;">
        Stockart
      </div>
      <h1 style="margin:0 0 6px; font-size:22px; font-weight:700; color:#000000; letter-spacing:-0.02em; line-height:1.25;">
        ${titleText}
      </h1>
      <p style="margin:0; font-size:12px; color:#525252; line-height:1.5;">
        Periode <strong style="color:#171717;">${periode}</strong> &middot; dibuat ${wibDateTime}
      </p>
    </div>

    <div style="padding:24px; background:#FFFFFF; color:#171717;">
      <p style="font-size:14px; margin:0 0 8px; color:#000000; line-height:1.5;">
        Halo <strong>Owner Stockart</strong>,
      </p>
      <p style="font-size:13px; line-height:1.6; color:#404040; margin:0 0 20px;">
        ${introText}
      </p>

      <!-- Ringkasan -->
      <div style="border:1px solid #D4D4D4; border-radius:6px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#F5F5F5; color:#171717; text-align:left; border-bottom:2px solid #000000;">
              <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Ringkasan</th>
              <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:right;">Nilai</th>
            </tr>
          </thead>
          <tbody>
            ${summaryRows}
          </tbody>
        </table>
      </div>

      <!-- Grafik Omzet -->
      ${chart ? buildReportChartHtml(chart) : ''}

      <!-- Produk Terlaris -->
      <div style="border:1px solid #D4D4D4; border-radius:6px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#F5F5F5; color:#171717; text-align:left; border-bottom:2px solid #000000;">
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center; width:36px;">No</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Produk Terlaris</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:center;">Terjual</th>
              <th style="padding:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; text-align:right;">Pendapatan</th>
            </tr>
          </thead>
          <tbody>
            ${topRows}
          </tbody>
        </table>
      </div>

      ${driveInfoHtml}

      <!-- Action Button / CTA -->
      <div style="text-align:center; margin:24px 0 16px;">
        <a href="${reportUrl}" style="display:inline-block; background:#000000; color:#FFFFFF; text-decoration:none; padding:12px 24px; border-radius:4px; font-size:13px; font-weight:700; letter-spacing:0.02em;">
          Buka Halaman Laporan &rarr;
        </a>
      </div>

      <!-- Footer Info -->
      <div style="border-top:1px solid #E5E5E5; padding-top:14px; margin-top:20px; font-size:11px; color:#525252; line-height:1.5;">
        ${footerText}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Mengirim email Laporan Penjualan & Stok ke Email Owner beserta lampiran file PDF.
 */
async function sendReportEmail({
  periodeLabel,
  summary,
  topProducts,
  to,
  driveInfo,
  pdfBuffer,
  chart,
  context,
  frequency,
}) {
  const html = buildReportHtml({
    periodeLabel,
    summary,
    topProducts,
    chart,
    to,
    driveInfo,
    context,
    frequency,
  });
  const finalPdfBuffer =
    pdfBuffer ||
    generateReportPdfBuffer({ periodeLabel, summary, topProducts, chart, context, frequency });
  const safeDate = new Date().toISOString().slice(0, 10);

  return sendEmail({
    to,
    subject: buildReportEmailSubject(periodeLabel, { context, frequency }),
    html,
    attachment: {
      filename: `Laporan_Stockart_${safeDate}.pdf`,
      contentBuffer: finalPdfBuffer,
      contentType: 'application/pdf',
    },
  });
}

module.exports = {
  isEmailConfigured,
  parseRecipients,
  getDefaultRecipientLabel,
  maskEmailAddress,
  maskEmailRecipients,
  validateOptionalEmailRecipients,
  sendEmail,
  sendLowStockAlertEmail,
  buildLowStockEmailSubject,
  buildLowStockEmailHeader,
  buildLowStockEmailBody,
  buildReportHtml,
  buildReportEmailSubject,
  getFrontendBaseUrl,
  sendReportEmail,
};
