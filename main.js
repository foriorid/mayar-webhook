import { Client, TablesDB, ID, Query } from 'node-appwrite';

const DATABASE_ID = process.env.DATABASE_ID;
const TABLE_ID = process.env.TABLE_ID;
const PROJECT_ID = process.env.APPWRITE_FUNCTION_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY;

// Function dan project kamu berada di region Singapore (SGP).
const APPWRITE_ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';

function parseRequestBody(req) {
  let body = req.bodyJson ?? req.body;

  if (typeof body === 'string') {
    body = JSON.parse(body);
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Request body bukan JSON yang valid.');
  }

  return body;
}

export default async ({ req, res, log, error }) => {
  if (req.method !== 'POST') {
    return res.json(
      { success: false, message: 'Method not allowed' },
      405
    );
  }

  if (!DATABASE_ID || !TABLE_ID || !PROJECT_ID || !API_KEY) {
    error('Konfigurasi Appwrite belum lengkap: periksa DATABASE_ID, TABLE_ID, APPWRITE_FUNCTION_PROJECT_ID, dan APPWRITE_API_KEY.');

    return res.json(
      { success: false, message: 'Konfigurasi database belum lengkap.' },
      500
    );
  }

  const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(PROJECT_ID)
    .setKey(API_KEY);

  const tablesDB = new TablesDB(client);

  try {
    const body = parseRequestBody(req);
    const event = String(body.event || body.type || '').toLowerCase();

    // Event test hanya mengetes koneksi database.
    // Event ini tidak membuat atau mengaktifkan lisensi.
    if (event === 'testing') {
      await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_ID,
        queries: [Query.limit(1)]
      });

      log('Tes koneksi Appwrite berhasil.');
      return res.json({
        success: true,
        message: 'Database connection successful. No license was changed.'
      });
    }

    const data = body.data || body;
    const paymentStatus = String(data.status || '').toUpperCase();

    const isSuccess =
      paymentStatus === 'SUCCESS' ||
      paymentStatus === 'PAID' ||
      event === 'payment.received' ||
      event === 'transaction.success';

    if (!isSuccess) {
      log(`Event diabaikan. Status: ${paymentStatus || 'tidak ada'}`);

      return res.json({
        success: true,
        message: 'Event ignored.'
      });
    }

    const email = String(
      data.customerEmail ||
      data.customer?.email ||
      data.email ||
      ''
    ).trim().toLowerCase();

    if (!email) {
      return res.json(
        { success: false, message: 'Email pelanggan tidak ditemukan.' },
        400
      );
    }

    const name = String(
      data.customerName ||
      data.customer?.name ||
      data.name ||
      'Pelanggan SmartListing'
    );

    const phone = String(
      data.customerMobile ||
      data.customer?.mobile ||
      data.phone ||
      ''
    );

    const paymentRef = String(
      data.id ||
      data.transactionId ||
      `MAYAR-${Date.now()}`
    );

    const productName = String(
      data.productName ||
      data.product_name ||
      ''
    ).toLowerCase();

    let tier = 'basic';
    let teamSlots = 0;

    if (/\b(developer|agency)\b/.test(productName)) {
      tier = 'developer';
      teamSlots = 4;
    } else if (/\bpro\b/.test(productName)) {
      tier = 'pro';
    }

    const result = await tablesDB.listRows({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      queries: [Query.equal('email', email)]
    });

    const licenseData = {
      tier,
      status: 'active',
      maxDevices: 2,
      teamSlots,
      paymentRef
    };

    if (result.rows.length > 0) {
      const existingRow = result.rows[0];

      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: TABLE_ID,
        rowId: existingRow.$id,
        data: licenseData
      });

      log(`Lisensi diperbarui untuk ${email}.`);
    } else {
      await tablesDB.createRow({
        databaseId: DATABASE_ID,
        tableId: TABLE_ID,
        rowId: ID.unique(),
        data: {
          userId: email,
          email,
          customerName: name,
          customerPhone: phone,
          tier,
          status: 'active',
          maxDevices: 2,
          activeDevices: [],
          teamSlots,
          paymentRef
        }
      });

      log(`Lisensi baru dibuat untuk ${email}.`);
    }

    return res.json({
      success: true,
      message: 'License activated successfully.',
      email,
      tier
    });
  } catch (err) {
    const details = {
      message: err?.message || 'Unknown error',
      code: err?.code,
      type: err?.type,
      cause: err?.cause?.message,
      causeCode: err?.cause?.code
    };

    error(`Gagal memproses webhook/database: ${JSON.stringify(details)}`);

    return res.json(
      {
        success: false,
        message: 'Gagal memproses webhook atau menyimpan data.'
      },
      500
    );
  }
};