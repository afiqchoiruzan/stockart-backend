'use strict';

/**
 * Mengunggah file laporan ke Google Drive melalui Google Apps Script Web App URL.
 * Otomatis membuat folder `StockArt_Reports` (jika belum ada) dan membagikannya ke email Owner.
 *
 * @param {object} options
 * @param {string} options.fileName    - Nama file laporan (mis. "Laporan_StockArt_2026-11-12.html")
 * @param {string} options.content     - Konten HTML/CSV laporan
 * @param {string} [options.ownerEmail]- Email pemilik toko yang diberi akses folder Drive
 * @param {string} [options.folderName]- Nama folder di Google Drive (default: "StockArt_Reports")
 */
async function uploadReportToDrive({ fileName, content, ownerEmail, folderName }) {
  const webhookUrl = (process.env.GDRIVE_WEBHOOK_URL || '').trim();

  if (!webhookUrl) {
    return {
      uploaded: false,
      reason: 'GDRIVE_WEBHOOK_URL belum dikonfigurasi di .env',
    };
  }

  const payload = {
    fileName: fileName || `Laporan_StockArt_${new Date().toISOString().slice(0, 10)}.pdf`,
    content,
    mimeType: 'application/pdf',
    ownerEmail: (ownerEmail || process.env.OWNER_EMAIL || '').trim(),
    folderName: folderName || 'StockArt_Reports',
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Respons Google Drive Web App tidak valid: ${text.slice(0, 200)}`);
  }

  if (!result.success) {
    throw new Error(result.error || 'Gagal menyimpan laporan ke Google Drive');
  }

  return {
    uploaded: true,
    fileId: result.fileId,
    fileName: result.fileName,
    fileUrl: result.fileUrl,
    folderUrl: result.folderUrl,
  };
}

module.exports = {
  uploadReportToDrive,
};

