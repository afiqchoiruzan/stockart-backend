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

/**
 * Mengirim email peringatan stok menipis (Low Stock Alert) ke Email Owner.
 */
async function sendLowStockAlertEmail(products, customRecipient) {
  const rows = products
    .map(
      (p) => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;"><strong>${p.nama}</strong></td>
        <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;">${p.kategori || '-'}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC; color:#D46743; font-weight:bold;">${p.stok}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #EDD5BC;">${p.stokMinimum}</td>
      </tr>`
    )
    .join('');

  const html = `
  <div style="font-family:Segoe UI, Arial, sans-serif; max-width:600px; margin:0 auto; border:1px solid #EDD5BC; border-radius:12px; overflow:hidden;">
    <div style="background:#D46743; color:#FFFFFF; padding:18px 24px;">
      <h2 style="margin:0; font-size:18px;">⚠️ Peringatan Stok Menipis — StockArt POS</h2>
      <p style="margin:4px 0 0; font-size:12px; opacity:0.9;">Toko Kelontong "Berkah" • Sistem Pemantauan Inventaris Otomatis</p>
    </div>
    <div style="padding:20px 24px; background:#FFF7EE; color:#2A1E17;">
      <p style="font-size:14px; margin-top:0;">Halo <strong>Owner Toko Berkah</strong>,</p>
      <p style="font-size:13px; line-height:1.5;">Sistem mendeteksi terdapat <strong>${products.length} produk</strong> yang jumlah stoknya telah menyentuh atau berada di bawah batas minimum:</p>
      <table style="width:100%; border-collapse:collapse; background:#FFFFFF; border-radius:8px; overflow:hidden; font-size:13px; margin:16px 0;">
        <thead>
          <tr style="background:#FFEAD3; text-align:left;">
            <th style="padding:10px 12px;">Nama Produk</th>
            <th style="padding:10px 12px;">Kategori</th>
            <th style="padding:10px 12px;">Sisa Stok</th>
            <th style="padding:10px 12px;">Min. Stok</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px; color:#755E52; margin-bottom:0;">Segera lakukan restock barang melalui Dashboard Owner StockArt.</p>
    </div>
  </div>`;

  return sendEmail({
    to: customRecipient,
    subject: `⚠️ [StockArt Alert] ${products.length} Produk Stok Menipis Perlu Restock`,
    html,
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
  buildReportHtml,
  sendReportEmail,
};
