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
 * Task 2: Membangun Subjek Email Dinamis berdasarkan data produk low stock dari backend.
 */
function buildLowStockEmailSubject(products, now = new Date()) {
  const items = Array.isArray(products) ? products : [];
  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const dateStr = formatShortWibDate(now);

  if (habisCount > 0) {
    return `🚨 [StockArt Kritis] ${habisCount} Produk Habis & ${menipisCount} Menipis Perlu Restock — ${dateStr}`;
  }
  return `⚠️ [StockArt Alert] ${items.length} Produk Stok Menipis Perlu Restock — ${dateStr}`;
}

/**
 * Task 2: Membangun Visual Header Banner HTML untuk Email Alert Low Stock.
 */
function buildLowStockEmailHeader(products, { wibDateTime, isCritical, habisCount, menipisCount }) {
  const bannerBg = isCritical
    ? 'linear-gradient(135deg, #B91C1C 0%, #DC2626 50%, #EF4444 100%)'
    : 'linear-gradient(135deg, #C2410C 0%, #EA580C 50%, #F97316 100%)';

  const badgeText = isCritical ? '🚨 STATUS: STOK HABIS (KRITIS)' : '⚠️ STATUS: PERINGATAN RESTOCK';

  return `
    <div style="background:${bannerBg}; color:#FFFFFF; padding:22px 24px; border-bottom:3px solid rgba(0,0,0,0.15);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size:11px; font-weight:800; letter-spacing:1px; text-transform:uppercase; background:rgba(0,0,0,0.25); padding:4px 10px; border-radius:20px;">
          Toko Kelontong "Berkah"
        </span>
        <span style="font-size:11px; font-weight:700; background:#FFFFFF; color:${isCritical ? '#B91C1C' : '#C2410C'}; padding:4px 10px; border-radius:20px;">
          ${badgeText}
        </span>
      </div>
      <h1 style="margin:6px 0 4px; font-size:20px; font-weight:800; letter-spacing:-0.3px; line-height:1.3;">
        ${isCritical ? 'Peringatan Darurat: Stok Barang Habis!' : 'Peringatan Inventaris: Stok Barang Menipis!'}
      </h1>
      <p style="margin:0; font-size:12px; opacity:0.95; line-height:1.4;">
        Sistem Otomasi Pemantauan POS StockArt • Waktu Deteksi: <strong>${wibDateTime}</strong>
      </p>
    </div>`;
}

/**
 * Task 3: Membangun Header Body (KPI Summary) dan Tabel Body Email sesuai skema models/Product.js.
 */
function buildLowStockEmailBody(products, { to, wibDateTime }) {
  const items = Array.isArray(products) ? [...products] : [];

  // Urutkan item dari stok terkecil (stok 0 paling atas)
  items.sort((a, b) => Number(a.stok || 0) - Number(b.stok || 0));

  const habisCount = items.filter((p) => Number(p.stok) <= 0).length;
  const menipisCount = items.filter(
    (p) => Number(p.stok) > 0 && Number(p.stok) <= Number(p.stokMinimum ?? 0)
  ).length;
  const totalItems = items.length;

  // Hitung perkiraan modal restock: sum((stokMinimum - stok) * hargaBeli)
  let estimasiModalRestock = 0;
  items.forEach((p) => {
    const targetRestock = Math.max(0, Number(p.stokMinimum ?? 0) - Number(p.stok || 0));
    const hargaBeli = Number(p.hargaBeli || 0);
    estimasiModalRestock += targetRestock * hargaBeli;
  });

  const tableRows = items
    .map((p, idx) => {
      const stokNum = Number(p.stok || 0);
      const minNum = Number(p.stokMinimum ?? 0);
      const isHabis = stokNum <= 0;
      const satuan = p.satuan || 'pcs';
      const kode = p.kodeProduk || `PRD-${idx + 1}`;
      const kategori = p.kategori || 'Umum';
      const hargaBeli = Number(p.hargaBeli || 0);
      const hargaJual = Number(p.hargaJual || 0);

      const statusBadge = isHabis
        ? '<span style="display:inline-block; padding:3px 8px; border-radius:4px; font-weight:800; font-size:10px; background:#FEE2E2; color:#991B1B; border:1px solid #FCA5A5;">HABIS (0)</span>'
        : '<span style="display:inline-block; padding:3px 8px; border-radius:4px; font-weight:800; font-size:10px; background:#FEF3C7; color:#92400E; border:1px solid #FDE68A;">MENIPIS</span>';

      return `
        <tr style="background:${idx % 2 === 0 ? '#FFFFFF' : '#FFFDF9'};">
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:12px; color:#57534E; text-align:center;">
            ${idx + 1}
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:12px;">
            <code style="font-family:Consolas, 'Courier New', monospace; font-weight:700; color:#1C1917; background:#F5F5F4; padding:2px 6px; border-radius:4px;">${kode}</code>
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:13px;">
            <strong style="color:#1C1917;">${p.nama}</strong>
            <div style="font-size:11px; color:#78716C; margin-top:2px;">
              <span style="background:#F5F5F4; padding:1px 6px; border-radius:3px;">${kategori}</span>
              ${p.deskripsi ? `• <em>${p.deskripsi}</em>` : ''}
            </div>
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:13px; text-align:center;">
            <strong style="color:${isHabis ? '#DC2626' : '#D97706'}; font-size:14px;">${stokNum}</strong>
            <span style="font-size:11px; color:#78716C; margin-left:2px;">${satuan}</span>
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:12px; text-align:center; color:#44403C;">
            <strong>${minNum}</strong>
            <span style="font-size:11px; color:#78716C; margin-left:2px;">${satuan}</span>
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; font-size:12px; font-family:Consolas, monospace; color:#292524; text-align:right;">
            <div>${formatRp(hargaBeli)}</div>
            <div style="font-size:10px; color:#78716C;">Jual: ${formatRp(hargaJual)}</div>
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #EDD5BC; text-align:center;">
            ${statusBadge}
          </td>
        </tr>`;
    })
    .join('');

  return `
    <div style="padding:24px 24px 16px; background:#FFFBF6; color:#292524;">
      <p style="font-size:14px; margin-top:0; line-height:1.5;">
        Halo <strong>Owner Toko Berkah</strong>,
      </p>
      <p style="font-size:13px; line-height:1.6; color:#44403C; margin-bottom:20px;">
        Sistem manajemen stok <strong>StockArt POS</strong> mendeteksi terdapat <strong>${totalItems} produk aktif</strong> pada katalog toko yang jumlah persediaannya berada pada atau di bawah batas minimum:
      </p>

      <!-- KPI Summary Cards -->
      <table style="width:100%; border-collapse:separate; border-spacing:10px 0; margin-bottom:22px;">
        <tr>
          <td style="width:33.33%; background:#FFFFFF; border:1px solid #E7E5E4; border-radius:8px; padding:12px 14px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:#78716C; text-transform:uppercase; letter-spacing:0.5px;">TOTAL TERDAMPAK</div>
            <div style="font-size:22px; font-weight:800; color:#1C1917; margin-top:4px;">${totalItems} <span style="font-size:12px; font-weight:500;">Produk</span></div>
          </td>
          <td style="width:33.33%; background:${habisCount > 0 ? '#FEF2F2' : '#FFFFFF'}; border:1px solid ${habisCount > 0 ? '#FCA5A5' : '#E7E5E4'}; border-radius:8px; padding:12px 14px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:${habisCount > 0 ? '#991B1B' : '#78716C'}; text-transform:uppercase; letter-spacing:0.5px;">STOK HABIS (0)</div>
            <div style="font-size:22px; font-weight:800; color:${habisCount > 0 ? '#DC2626' : '#1C1917'}; margin-top:4px;">${habisCount} <span style="font-size:12px; font-weight:500;">Produk</span></div>
          </td>
          <td style="width:33.33%; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; padding:12px 14px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:#92400E; text-transform:uppercase; letter-spacing:0.5px;">STOK MENIPIS</div>
            <div style="font-size:22px; font-weight:800; color:#D97706; margin-top:4px;">${menipisCount} <span style="font-size:12px; font-weight:500;">Produk</span></div>
          </td>
        </tr>
      </table>

      <!-- Tabel Rincian Produk Sesuai Skema Backend -->
      <div style="border:1px solid #EDD5BC; border-radius:8px; overflow:hidden; background:#FFFFFF; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#FFEAD3; color:#44403C; text-align:left;">
              <th style="padding:10px 12px; font-size:11px; text-align:center; width:36px;">No</th>
              <th style="padding:10px 12px; font-size:11px;">Kode</th>
              <th style="padding:10px 12px; font-size:11px;">Nama Produk &amp; Kategori</th>
              <th style="padding:10px 12px; font-size:11px; text-align:center;">Sisa Stok</th>
              <th style="padding:10px 12px; font-size:11px; text-align:center;">Min. Stok</th>
              <th style="padding:10px 12px; font-size:11px; text-align:right;">Harga Beli</th>
              <th style="padding:10px 12px; font-size:11px; text-align:center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>

      <!-- Rekomendasi Restock & Modal -->
      <div style="background:#FFFFFF; border:1px solid #EDD5BC; border-left:4px solid #EA580C; border-radius:6px; padding:14px 18px; margin-bottom:20px;">
        <div style="font-size:12px; font-weight:700; color:#1C1917; margin-bottom:4px;">
          💡 Rekomendasi Tindakan Cepat:
        </div>
        <div style="font-size:12px; line-height:1.5; color:#57534E;">
          Perkiraan modal pengadaan kembali untuk mengisi produk di atas ke batas minimum adalah <strong>${formatRp(estimasiModalRestock)}</strong>.
          Lakukan restock barang segera agar transaksi kasir tidak terganggu oleh stok kosong.
        </div>
      </div>

      <!-- Action Button / CTA -->
      <div style="text-align:center; margin:24px 0 16px;">
        <a href="http://localhost:3000/owner/produk" style="display:inline-block; background:#1C1917; color:#FFFFFF; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:13px; font-weight:700; letter-spacing:0.3px;">
          Buka Manajemen Produk di Dashboard Owner &rarr;
        </a>
      </div>

      <!-- Footer Info -->
      <div style="border-top:1px solid #E7E5E4; padding-top:14px; margin-top:20px; font-size:11px; color:#78716C; line-height:1.5;">
        Notifikasi dikirim otomatis oleh server <strong>StockArt Backend</strong> ke <strong>${to || process.env.OWNER_EMAIL}</strong> saat mutasi transaksi kasir atau update inventaris memicu stok di bawah batas aman.
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
<body style="margin:0; padding:16px; background:#F5F5F4; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width:680px; margin:0 auto; background:#FFFFFF; border:1px solid #D6D3D1; border-radius:12px; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
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
