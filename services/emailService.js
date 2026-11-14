'use strict';

const tls = require('node:tls');
const { generateReportPdfBuffer } = require('./pdfService');

/**
 * Mengirim email melalui Gmail SMTP over SSL/TLS (port 465)
 * menggunakan modul bawaan Node.js (`node:tls`), mendukung lampiran file PDF (multipart/mixed).
 *
 * @param {object} options
 * @param {string} [options.to]             - Email penerima (default: process.env.OWNER_EMAIL)
 * @param {string} options.subject          - Subjek email
 * @param {string} options.html             - Isi email dalam format HTML
 * @param {object} [options.attachment]     - Lampiran file opsional { filename, contentBuffer, contentType }
 */
function sendEmail({ to, subject, html, attachment }) {
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const recipient = (to || process.env.OWNER_EMAIL || '').trim();

  if (!smtpUser || !smtpPass || !recipient) {
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
    let buffer = '';

    const sendLine = (line) => {
      socket.write(line + '\r\n');
    };

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Koneksi ke server SMTP Gmail timeout'));
    });

    socket.on('error', (err) => {
      reject(err);
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
          sendLine(`RCPT TO:<${recipient}>`);
        } else if (step === 6 && code === 250) {
          step = 7;
          sendLine('DATA');
        } else if (step === 7 && code === 354) {
          step = 8;
          const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
          const htmlBase64 = Buffer.from(html, 'utf8')
            .toString('base64')
            .replace(/(.{76})/g, '$1\r\n');

          let message;
          if (attachment && attachment.contentBuffer) {
            const boundary = `----=_StockArtBoundary_${Date.now()}`;
            const attachBase64 = Buffer.from(attachment.contentBuffer)
              .toString('base64')
              .replace(/(.{76})/g, '$1\r\n');
            const mimeType = attachment.contentType || 'application/pdf';

            message = [
              `From: "StockArt POS System" <${smtpUser}>`,
              `To: <${recipient}>`,
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
              `From: "StockArt POS System" <${smtpUser}>`,
              `To: <${recipient}>`,
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
            to: recipient,
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

/**
 * Membangun Subjek Email Dinamis tanpa emoji berdasarkan data produk low stock dari backend.
 */
function buildLowStockEmailSubject(products, now = new Date()) {
  const items = Array.isArray(products) ? products : [];
  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const dateStr = formatShortWibDate(now);

  if (habisCount > 0) {
    return `[StockArt Kritis] ${habisCount} Produk Habis & ${menipisCount} Menipis Perlu Restock — ${dateStr}`;
  }
  return `[StockArt Alert] ${items.length} Produk Stok Menipis Perlu Restock — ${dateStr}`;
}

/**
 * Membangun Visual Header HTML (Monokrom + Aksen Merah khusus status low stock, tanpa emoji).
 */
function buildLowStockEmailHeader(products, { wibDateTime, isCritical, habisCount, menipisCount }) {
  const badgeText = isCritical
    ? 'STATUS: STOK HABIS (KRITIS)'
    : 'STATUS: STOK MENIPIS';

  const totalAffected = Number(habisCount || 0) + Number(menipisCount || 0);
  const badgeStyle = totalAffected > 0
    ? 'background:#FEF2F2; color:#991B1B; border:1px solid #DC2626;'
    : 'background:#F5F5F5; color:#171717; border:1px solid #D4D4D4;';

  return `
    <div style="background:#FFFFFF; border-top:4px solid #000000; border-bottom:1px solid #E5E5E5; padding:24px 24px 20px;">
      <table role="presentation" style="width:100%; border-collapse:collapse; margin-bottom:12px;">
        <tr>
          <td style="vertical-align:middle;">
            <span style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#525252;">
              STOCKART POS &middot; INVENTORY ALERT
            </span>
          </td>
          <td style="text-align:right; vertical-align:middle;">
            <span style="display:inline-block; font-size:11px; font-weight:700; letter-spacing:0.04em; padding:4px 10px; border-radius:4px; ${badgeStyle}">
              ${badgeText}
            </span>
          </td>
        </tr>
      </table>
      <div style="font-size:12px; font-weight:700; color:#000000; margin-bottom:4px;">
        Toko Kelontong "Berkah"
      </div>
      <h1 style="margin:0 0 6px; font-size:22px; font-weight:700; color:#000000; letter-spacing:-0.02em; line-height:1.25;">
        Peringatan Stok Produk Menipis
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
function buildLowStockEmailBody(products, { to, wibDateTime }) {
  const items = Array.isArray(products) ? [...products] : [];

  // Urutkan item dari stok terkecil (stok 0 paling atas)
  items.sort((a, b) => Number(a.stok || 0) - Number(b.stok || 0));

  const frontendBase = (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')[0]
    .trim()
    .replace(/\/+$/, '');
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

  return `
    <div style="padding:24px; background:#FFFFFF; color:#171717;">
      <p style="font-size:14px; margin:0 0 8px; color:#000000; line-height:1.5;">
        Halo <strong>Owner Toko Berkah</strong>,
      </p>
      <p style="font-size:13px; line-height:1.6; color:#404040; margin:0 0 20px;">
        Berikut ringkasan produk aktif pada katalog <strong>StockArt POS</strong> yang perlu segera diperhatikan pada pengecekan <strong>${wibDateTime}</strong>:
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
        Notifikasi dikirim otomatis oleh server <strong style="color:#171717;">StockArt Backend</strong> ke <strong style="color:#171717;">${to || process.env.OWNER_EMAIL}</strong> saat transaksi kasir atau pembaruan inventaris memicu stok di bawah batas minimum.
      </div>
    </div>`;
}

/**
 * Mengirim email peringatan stok menipis (Low Stock Alert) ke Email Owner.
 */
async function sendLowStockAlertEmail(products, customRecipient) {
  const items = Array.isArray(products) ? products : [];
  if (items.length === 0) {
    return { success: false, message: 'Tidak ada produk yang perlu dilaporkan' };
  }

  const now = new Date();
  const wibDateTime = formatWibDate(now);
  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const isCritical = habisCount > 0;

  const recipient = (customRecipient || process.env.OWNER_EMAIL || '').trim();
  const subject = buildLowStockEmailSubject(items, now);

  const headerHtml = buildLowStockEmailHeader(items, {
    wibDateTime,
    isCritical,
    habisCount,
    menipisCount,
  });

  const bodyHtml = buildLowStockEmailBody(items, {
    to: recipient,
    wibDateTime,
  });

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Peringatan Stok Menipis StockArt</title>
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

/**
 * Membangun HTML Laporan Keuangan & Penjualan Produk.
 */
function buildReportHtml({ periodeLabel, summary, topProducts, to, driveInfo }) {
  const formatRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

  const topRows =
    topProducts && topProducts.length > 0
      ? topProducts
          .map(
            (item, idx) => `
          <tr>
            <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;">#${idx + 1}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;"><strong>${item.namaProduk}</strong></td>
            <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;">${item.totalTerjual} unit</td>
            <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;">${formatRp(item.totalPendapatan)}</td>
          </tr>`
          )
          .join('')
      : `<tr><td colspan="4" style="padding:12px; text-align:center; color:#755E52;">Belum ada transaksi pada periode ini</td></tr>`;

  const driveBanner =
    driveInfo && driveInfo.uploaded
      ? `
      <div style="margin-top:16px; padding:12px 16px; background:#E5F5F6; border:1px solid #9BD4D8; border-radius:8px; font-size:13px; color:#2B6F75;">
        <strong>☁️ Tersimpan Otomatis di Google Drive Owner:</strong><br/>
        • File Laporan: <a href="${driveInfo.fileUrl}" style="color:#D46743; font-weight:bold;">${driveInfo.fileName}</a><br/>
        • Folder Drive: <a href="${driveInfo.folderUrl}" style="color:#2B6F75; font-weight:bold;">Buka Folder StockArt_Reports</a>
      </div>`
      : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Laporan StockArt</title></head>
<body style="margin:0; padding:16px; background:#FFFFFF;">
  <div style="font-family:Segoe UI, Arial, sans-serif; max-width:640px; margin:0 auto; border:1px solid #EDD5BC; border-radius:12px; overflow:hidden;">
    <div style="background:linear-gradient(135deg, #D46743, #E89B5B); color:#FFFFFF; padding:20px 24px;">
      <h2 style="margin:0; font-size:19px;">📊 Laporan Keuangan & Penjualan — StockArt POS</h2>
      <p style="margin:4px 0 0; font-size:12px; opacity:0.95;">Toko Kelontong "Berkah" • Periode: ${periodeLabel}</p>
    </div>
    <div style="padding:20px 24px; background:#FFF7EE; color:#2A1E17;">
      <div style="display:flex; gap:12px; margin-bottom:18px;">
        <div style="flex:1; background:#FFFFFF; border:1px solid #EDD5BC; border-radius:8px; padding:12px;">
          <div style="font-size:11px; color:#755E52;">TOTAL OMZET KEUANGAN</div>
          <div style="font-size:18px; font-weight:bold; color:#D46743; margin-top:4px;">${formatRp(summary.totalOmzet)}</div>
        </div>
        <div style="flex:1; background:#FFFFFF; border:1px solid #EDD5BC; border-radius:8px; padding:12px;">
          <div style="font-size:11px; color:#755E52;">TOTAL TRANSAKSI</div>
          <div style="font-size:18px; font-weight:bold; color:#2A1E17; margin-top:4px;">${summary.totalTransaksi} Struk</div>
        </div>
        <div style="flex:1; background:#FFFFFF; border:1px solid #EDD5BC; border-radius:8px; padding:12px;">
          <div style="font-size:11px; color:#755E52;">TOTAL KATALOG AKTIF</div>
          <div style="font-size:18px; font-weight:bold; color:#2B6F75; margin-top:4px;">${summary.totalProduk} Produk</div>
        </div>
      </div>

      <h3 style="font-size:14px; margin:16px 0 8px; color:#2A1E17;">🏆 Produk Terlaris (Top Selling Products)</h3>
      <table style="width:100%; border-collapse:collapse; background:#FFFFFF; border-radius:8px; overflow:hidden; font-size:13px;">
        <thead>
          <tr style="background:#FFEAD3; text-align:left;">
            <th style="padding:8px 12px;">No</th>
            <th style="padding:8px 12px;">Nama Produk</th>
            <th style="padding:8px 12px;">Terjual</th>
            <th style="padding:8px 12px;">Pendapatan</th>
          </tr>
        </thead>
        <tbody>${topRows}</tbody>
      </table>

      ${driveBanner}

      <p style="font-size:12px; color:#755E52; margin-top:16px; margin-bottom:0;">
        📎 <strong>File PDF Laporan</strong> telah dilampirkan pada email ini.<br/>
        Dikirim otomatis oleh layanan <strong>StockArt Backend</strong> (${process.env.SMTP_USER}) ke Email Owner (${to || process.env.OWNER_EMAIL}).
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Mengirim email Laporan Keuangan & Penjualan Produk ke Email Owner beserta lampiran file PDF.
 */
async function sendReportEmail({ periodeLabel, summary, topProducts, to, driveInfo, pdfBuffer }) {
  const html = buildReportHtml({ periodeLabel, summary, topProducts, to, driveInfo });
  const finalPdfBuffer =
    pdfBuffer || generateReportPdfBuffer({ periodeLabel, summary, topProducts });
  const safeDate = new Date().toISOString().slice(0, 10);

  return sendEmail({
    to,
    subject: `📊 [StockArt Report] Laporan Keuangan & Inventaris (${periodeLabel})`,
    html,
    attachment: {
      filename: `Laporan_StockArt_${safeDate}.pdf`,
      contentBuffer: finalPdfBuffer,
      contentType: 'application/pdf',
    },
  });
}

module.exports = {
  sendEmail,
  sendLowStockAlertEmail,
  buildLowStockEmailSubject,
  buildLowStockEmailHeader,
  buildLowStockEmailBody,
  buildReportHtml,
  sendReportEmail,
};
