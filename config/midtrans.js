// Konfigurasi Midtrans Core API. Proyek ini HANYA memakai sandbox.
const SANDBOX_BASE_URL = 'https://api.sandbox.midtrans.com';

const fail = (message) => Object.assign(new Error(message), { statusCode: 500 });

// Dibaca saat dipakai (bukan saat require) agar server tetap bisa jalan tanpa key,
// dan agar tes dapat mengganti process.env.
const getMidtransConfig = () => {
    const serverKey = (process.env.MIDTRANS_SERVER_KEY || '').trim();
    // Dashboard Midtrans versi baru memisahkan "Signature Secret Key" (untuk signature_key webhook)
    // dari Server Key (untuk Basic auth API). Jika tidak diisi, pakai Server Key (akun lama: keduanya sama).
    const signatureKey = (process.env.MIDTRANS_SIGNATURE_KEY || '').trim() || serverKey;
    const baseUrl = (process.env.MIDTRANS_BASE_URL || SANDBOX_BASE_URL).trim().replace(/\/+$/, '');

    if (!serverKey) {
        throw fail('MIDTRANS_SERVER_KEY belum diatur');
    }

    let host;
    try {
        host = new URL(baseUrl).host;
    } catch {
        throw fail('MIDTRANS_BASE_URL tidak valid');
    }
    if (host !== 'api.sandbox.midtrans.com') {
        throw fail('MIDTRANS_BASE_URL harus memakai sandbox (api.sandbox.midtrans.com)');
    }

    return {
        serverKey,
        signatureKey,
        baseUrl,
        // Basic auth: base64("<SERVER_KEY>:")
        authHeader: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`,
    };
};

const isMidtransConfigured = () => {
    try {
        getMidtransConfig();
        return true;
    } catch {
        return false;
    }
};

module.exports = { getMidtransConfig, isMidtransConfigured, SANDBOX_BASE_URL };
