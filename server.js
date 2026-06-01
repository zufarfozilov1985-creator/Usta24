'use strict';

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const path         = require('path');
const { Pool }     = require('pg');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');
const axios        = require('axios');
require('dotenv').config();

// ─────────────────────────────────────────────
// MUHIT TEKSHIRUVI
// ─────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD) {
  const MAJBURIY = ['JWT_SECRET', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
                    'CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY',
                    'ESKIZ_EMAIL', 'ESKIZ_PASSWORD'];
  const YETISHMAYDI = MAJBURIY.filter(k => !process.env[k]);
  if (YETISHMAYDI.length) {
    console.error('❌ .env da yetishmaydi:', YETISHMAYDI.join(', '));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// ILOVA VA PORTGA ULASH
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// MA'LUMOTLAR BAZASI
// ─────────────────────────────────────────────
const pool = new Pool({
  host:            process.env.DB_HOST     || 'localhost',
  port:            parseInt(process.env.DB_PORT) || 5432,
  database:        process.env.DB_NAME     || 'usta24',
  user:            process.env.DB_USER     || 'postgres',
  password:        process.env.DB_PASSWORD || '',
  max:             10,          // maksimal ulanish
  idleTimeoutMillis:   30000,
  connectionTimeoutMillis: 5000,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('⚠️  DB ulanish xatosi:', err.message);
});

// ─────────────────────────────────────────────
// MIDDLEWARE — XAVFSIZLIK
// ─────────────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,   // SPA uchun o'chirildi
}));

// CORS — faqat ruxsat etilgan domenlar
const RUXSAT_DOMENLAR = (process.env.ALLOWED_ORIGINS || 'http://localhost:5000')
  .split(',').map(d => d.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || RUXSAT_DOMENLAR.includes(origin) || !IS_PROD) return cb(null, true);
    cb(new Error('CORS: ruxsatsiz domen'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10kb' }));   // katta so'rovlarni blok
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'www'), {
  maxAge: IS_PROD ? '7d' : 0,
}));

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
// Umumiy cheklov
const umumiyLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 daqiqa
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { xato: 'Juda ko\'p so\'rov. 15 daqiqadan keyin urinib ko\'ring.' },
});

// SMS uchun qat'iy cheklov (suiiste'molga qarshi)
const smsLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 soat
  max: IS_PROD ? 5 : 100,     // production'da 1 soatda max 5 SMS
  message: { xato: 'SMS chekovi: 1 soatda 5 ta SMS. Keyinroq urinib ko\'ring.' },
  skip: () => !IS_PROD,       // dev'da o'chirilgan
});

// Auth endpointlar uchun cheklov
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 20 : 1000,
  message: { xato: 'Juda ko\'p urinish. Bir oz kuting.' },
});

app.use(umumiyLimit);

// ─────────────────────────────────────────────
// YORDAMCHI FUNKSIYALAR
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (IS_PROD) { console.error('❌ JWT_SECRET kamida 32 belgi bo\'lishi kerak!'); process.exit(1); }
  else console.warn('⚠️  DEV: JWT_SECRET kuchsiz yoki yo\'q');
}

function tokenTekshir(req, res, keyingi) {
  const sarlavha = req.headers.authorization;
  if (!sarlavha || !sarlavha.startsWith('Bearer '))
    return res.status(401).json({ xato: 'Tizimga kirish talab etiladi' });
  try {
    req.foydalanuvchi = jwt.verify(sarlavha.split(' ')[1], JWT_SECRET || 'dev-secret-key-32chars-minimum!!');
    keyingi();
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ xato: 'Token muddati tugagan. Qayta kiring.' });
    res.status(401).json({ xato: 'Token yaroqsiz' });
  }
}

// Faqat admin uchun
function adminTekshir(req, res, keyingi) {
  tokenTekshir(req, res, () => {
    if (req.foydalanuvchi?.rol !== 'admin')
      return res.status(403).json({ xato: 'Admin huquqi talab etiladi' });
    keyingi();
  });
}

// UUID tekshirish
function uuidTekshir(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ─────────────────────────────────────────────
// ESKIZ SMS INTEGRATSIYASI
// ─────────────────────────────────────────────
let eskizToken = process.env.ESKIZ_EMAIL === 'token' ? process.env.ESKIZ_PASSWORD : (process.env.ESKIZ_TOKEN || null);
let tokenVaqti = 0;

async function eskizTokenOlish() {
  try {
    const r = await axios.post('https://notify.eskiz.uz/api/auth/login', {
      email:    process.env.ESKIZ_EMAIL,
      password: process.env.ESKIZ_PASSWORD,
    }, { timeout: 10000 });
    eskizToken = r.data?.data?.token;
    tokenVaqti = Date.now();
    console.log('✅ Eskiz token yangilandi');
    return eskizToken;
  } catch (e) {
    console.error('❌ Eskiz login xatosi:', e.response?.data || e.message);
    return null;
  }
}

async function smsPomborish(telefon, kod) {
  // Development rejimida SMS yuborilmaydi
  if (!IS_PROD) {
    console.log(`[DEV] SMS ${telefon} => ${kod}`);
    return true;
  }

  // Token 23 soatdan eski bo'lsa yangilanadi
  if (!eskizToken || (Date.now() - tokenVaqti) > 23 * 60 * 60 * 1000) {
    await eskizTokenOlish();
  }

  if (!eskizToken) return false;

  try {
    const matn = `Yechim24.uz kirish kodi: ${kod}\nKod 5 daqiqa amal qiladi. Hech kimga bermang!`;
    const r = await axios.post('https://notify.eskiz.uz/api/message/sms/send', {
      mobile_phone: telefon.replace('+', ''),
      message: matn,
      from: '4546',
    }, {
      headers: { Authorization: `Bearer ${eskizToken}` },
      timeout: 15000,
    });
    return r.data?.status === 'waiting';
  } catch (e) {
    // Token muddati o'tgan bo'lsa qayta urinib ko'r
    if (e.response?.status === 401) {
      await eskizTokenOlish();
      return false;
    }
    console.error('❌ SMS yuborish xatosi:', e.response?.data || e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// CLICK TO'LOV IMZO TEKSHIRUVI
// ─────────────────────────────────────────────
function clickImzo(p) {
  const qator = [
    p.click_trans_id,
    p.service_id,
    process.env.CLICK_SECRET_KEY || '',
    p.merchant_trans_id,
    p.amount,
    p.action,
    p.sign_time,
  ].join('');
  const hisob = crypto.createHash('md5').update(qator).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hisob), Buffer.from(p.sign_string || ''));
}

// ─────────────────────────────────────────────
// SALOMLASHUV / HOLAT TEKSHIRUVI
// ─────────────────────────────────────────────
app.get('/salomatlik', async (req, res) => {
  try {
    const t = Date.now();
    await pool.query('SELECT 1');
    res.json({
      holat:   'yaxshi',
      db:      'ulangan',
      db_ms:   Date.now() - t,
      server:  'Yechim24.uz',
      versiya: '2.0.0',
      muhit:   IS_PROD ? 'production' : 'development',
    });
  } catch (x) {
    res.status(500).json({ holat: 'xato', xabar: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// USTALAR
// ─────────────────────────────────────────────
app.get('/api/ustalar', async (req, res) => {
  const { kategoriya, top_rejim, qidiruv, sahifa, limit } = req.query;

  const sah = Math.max(1, parseInt(sahifa) || 1);
  const lim = Math.min(50, Math.max(1, parseInt(limit) || 12));
  const offset = (sah - 1) * lim;

  const RUXSAT_REJIMLAR = ['reyting', 'premium', 'arzon', 'tajriba'];
  const rejim = RUXSAT_REJIMLAR.includes(top_rejim) ? top_rejim : 'reyting';

  const SARALASH = {
    reyting:  'up.reyting DESC, up.baholar_soni DESC',
    premium:  'up.oylik_tolov DESC, up.reyting DESC',
    arzon:    'up.soatlik_narx ASC',
    tajriba:  'up.tajriba_yil DESC',
  };

  try {
    let sh = ['f.faol = TRUE'], q = [], i = 1;

    if (kategoriya && kategoriya !== 'barchasi') {
      sh.push(`up.kategoriya = $${i++}`);
      q.push(kategoriya);
    }
    if (qidiruv && qidiruv.trim()) {
      sh.push(`(f.ism ILIKE $${i} OR up.mutaxassislik ILIKE $${i})`);
      q.push('%' + qidiruv.trim().slice(0, 100) + '%');
      i++;
    }

    const shart = sh.join(' AND ');
    const SELECT = `SELECT up.id, up.kategoriya, up.mutaxassislik, up.tavsif,
      up.soatlik_narx, up.tajriba_yil, up.ko_nikmalar, up.joylashuv,
      up.mavjud, up.reyting, up.baholar_soni, up.bajarilgan_ishlar,
      up.oylik_tolov, up.premium, f.ism, f.avatar_url
      FROM usta_profillari up
      JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id
      WHERE ${shart} ORDER BY ${SARALASH[rejim]}
      LIMIT $${i} OFFSET $${i + 1}`;

    q.push(lim, offset);

    const COUNT = `SELECT COUNT(*) FROM usta_profillari up
      JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id
      WHERE ${shart}`;

    const [ustalar, son] = await Promise.all([
      pool.query(SELECT, q),
      pool.query(COUNT, q.slice(0, -2)),
    ]);

    res.json({
      malumotlar:    ustalar.rows,
      jami:          parseInt(son.rows[0].count),
      sahifa:        sah,
      jami_sahifalar: Math.ceil(son.rows[0].count / lim),
    });
  } catch (x) {
    console.error('GET /api/ustalar:', x.message);
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.get('/api/ustalar/:id', async (req, res) => {
  if (!uuidTekshir(req.params.id))
    return res.status(400).json({ xato: 'Noto\'g\'ri ID format' });
  try {
    const n = await pool.query(
      `SELECT up.*, f.ism, f.avatar_url
       FROM usta_profillari up
       JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id
       WHERE up.id = $1 AND f.faol = TRUE`,
      [req.params.id]
    );
    if (!n.rows.length) return res.status(404).json({ xato: 'Usta topilmadi' });
    res.json(n.rows[0]);
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// Usta profil tahrirlash
app.patch('/api/ustalar/profil', tokenTekshir, async (req, res) => {
  const { mutaxassislik, tavsif, soatlik_narx, tajriba_yil, ko_nikmalar, joylashuv, mavjud } = req.body;
  try {
    const n = await pool.query(
      `UPDATE usta_profillari SET
        mutaxassislik = COALESCE($1, mutaxassislik),
        tavsif        = COALESCE($2, tavsif),
        soatlik_narx  = COALESCE($3, soatlik_narx),
        tajriba_yil   = COALESCE($4, tajriba_yil),
        ko_nikmalar   = COALESCE($5, ko_nikmalar),
        joylashuv     = COALESCE($6, joylashuv),
        mavjud        = COALESCE($7, mavjud)
       WHERE foydalanuvchi_id = $8 RETURNING *`,
      [mutaxassislik, tavsif, soatlik_narx, tajriba_yil, ko_nikmalar, joylashuv, mavjud, req.foydalanuvchi.id]
    );
    if (!n.rows.length) return res.status(404).json({ xato: 'Usta profili topilmadi' });
    res.json({ muvaffaqiyat: true, profil: n.rows[0] });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// AUTH — SMS OTP
// ─────────────────────────────────────────────
app.post('/api/auth/sms-yuborish', smsLimit, authLimit, async (req, res) => {
  const { telefon } = req.body;
  if (!telefon || !/^\+998\d{9}$/.test(telefon))
    return res.status(400).json({ xato: 'Telefon noto\'g\'ri (+998XXXXXXXXX)' });

  try {
    // Oxirgi 1 daqiqada yuborilgan OTP bor-yo'qligini tekshir
    const oxirgi = await pool.query(
      `SELECT id FROM otp_kodlar
       WHERE telefon = $1 AND ishlatildi = FALSE
         AND muddati > NOW()
         AND yaratildi > NOW() - INTERVAL '1 minute'
       LIMIT 1`,
      [telefon]
    );
    if (oxirgi.rows.length)
      return res.status(429).json({ xato: '1 daqiqa ichida qayta so\'rov yuborib bo\'lmaydi' });

    const kod = Math.floor(100000 + Math.random() * 900000).toString();
    const muddati = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query('UPDATE otp_kodlar SET ishlatildi = TRUE WHERE telefon = $1', [telefon]);
    await pool.query(
      'INSERT INTO otp_kodlar (telefon, kod, muddati) VALUES ($1, $2, $3)',
      [telefon, kod, muddati]
    );

    const smsYuborildi = await smsPomborish(telefon, kod);

    // MUHIM: dev_kod faqat development'da qaytariladi
    const javob = { muvaffaqiyat: true, sms: smsYuborildi };
    if (!IS_PROD) javob.dev_kod = kod;   // ← production'da HECH QACHON!

    res.json(javob);
  } catch (x) {
    console.error('sms-yuborish:', x.message);
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.post('/api/auth/kod-tasdiqlash', authLimit, async (req, res) => {
  const { telefon, kod, ism } = req.body;
  if (!telefon || !kod)
    return res.status(400).json({ xato: 'Telefon va kod majburiy' });
  if (!/^\d{6}$/.test(kod))
    return res.status(400).json({ xato: 'Kod 6 ta raqamdan iborat' });

  try {
    const n = await pool.query(
      `SELECT * FROM otp_kodlar
       WHERE telefon = $1 AND kod = $2 AND ishlatildi = FALSE AND muddati > NOW()
       ORDER BY yaratildi DESC LIMIT 1`,
      [telefon, kod]
    );
    if (!n.rows.length) return res.status(400).json({ xato: 'Kod noto\'g\'ri yoki muddati o\'tgan' });

    await pool.query('UPDATE otp_kodlar SET ishlatildi = TRUE WHERE id = $1', [n.rows[0].id]);

    let f;
    const m = await pool.query('SELECT * FROM foydalanuvchilar WHERE telefon = $1', [telefon]);
    if (m.rows.length) {
      f = m.rows[0];
      if (!f.faol) return res.status(403).json({ xato: 'Hisob bloklangan' });
      await pool.query('UPDATE foydalanuvchilar SET tasdiqlangan = TRUE WHERE id = $1', [f.id]);
    } else {
      const ismToza = (ism || 'Foydalanuvchi').trim().slice(0, 100);
      const y = await pool.query(
        'INSERT INTO foydalanuvchilar (telefon, ism, tasdiqlangan) VALUES ($1, $2, TRUE) RETURNING *',
        [telefon, ismToza]
      );
      f = y.rows[0];
    }

    const secret = JWT_SECRET || 'dev-secret-key-32chars-minimum!!';
    const token = jwt.sign(
      { id: f.id, telefon: f.telefon, rol: f.rol },
      secret,
      { expiresIn: '30d' }
    );

    res.json({
      muvaffaqiyat: true,
      token,
      foydalanuvchi: { id: f.id, ism: f.ism, telefon: f.telefon, rol: f.rol, avatar_url: f.avatar_url },
    });
  } catch (x) {
    console.error('kod-tasdiqlash:', x.message);
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// Token yangilash
app.post('/api/auth/yangilash', tokenTekshir, async (req, res) => {
  try {
    const f = await pool.query('SELECT id, ism, telefon, rol, avatar_url, faol FROM foydalanuvchilar WHERE id = $1', [req.foydalanuvchi.id]);
    if (!f.rows.length || !f.rows[0].faol) return res.status(401).json({ xato: 'Hisob topilmadi' });
    const secret = JWT_SECRET || 'dev-secret-key-32chars-minimum!!';
    const token = jwt.sign(
      { id: f.rows[0].id, telefon: f.rows[0].telefon, rol: f.rows[0].rol },
      secret,
      { expiresIn: '30d' }
    );
    res.json({ token, foydalanuvchi: f.rows[0] });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// BUYURTMALAR
// ─────────────────────────────────────────────
app.post('/api/buyurtmalar', tokenTekshir, async (req, res) => {
  const { usta_id, sarlavha, tavsif, soat, manzil } = req.body;
  if (!usta_id || !sarlavha) return res.status(400).json({ xato: 'Usta va sarlavha majburiy' });
  if (!uuidTekshir(usta_id)) return res.status(400).json({ xato: 'Noto\'g\'ri usta ID' });
  if (sarlavha.length > 255) return res.status(400).json({ xato: 'Sarlavha 255 belgidan oshmasin' });
  const soatSon = Math.min(24, Math.max(1, parseInt(soat) || 1));

  try {
    const u = await pool.query('SELECT * FROM usta_profillari WHERE id = $1 AND mavjud = TRUE', [usta_id]);
    if (!u.rows.length) return res.status(404).json({ xato: 'Usta topilmadi yoki band' });

    // O'z-o'ziga buyurtma bermaslik
    if (u.rows[0].foydalanuvchi_id === req.foydalanuvchi.id)
      return res.status(400).json({ xato: 'O\'z-o\'zingizga buyurtma bera olmaysiz' });

    const jami = u.rows[0].soatlik_narx * soatSon;
    const n = await pool.query(
      `INSERT INTO buyurtmalar (mijoz_id, usta_id, sarlavha, tavsif, soat, jami_miqdor, manzil)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.foydalanuvchi.id, usta_id, sarlavha.trim(), tavsif, soatSon, jami, manzil]
    );
    res.status(201).json({ muvaffaqiyat: true, buyurtma: n.rows[0] });
  } catch (x) {
    console.error('POST /api/buyurtmalar:', x.message);
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.get('/api/buyurtmalar', tokenTekshir, async (req, res) => {
  try {
    const n = await pool.query(
      `SELECT b.*, up.mutaxassislik, f.ism AS usta_ismi, f.avatar_url AS usta_avatar
       FROM buyurtmalar b
       JOIN usta_profillari up ON up.id = b.usta_id
       JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id
       WHERE b.mijoz_id = $1
       ORDER BY b.yaratildi DESC
       LIMIT 50`,
      [req.foydalanuvchi.id]
    );
    res.json(n.rows);
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// Buyurtmani bekor qilish
app.patch('/api/buyurtmalar/:id/bekor', tokenTekshir, async (req, res) => {
  if (!uuidTekshir(req.params.id)) return res.status(400).json({ xato: 'Noto\'g\'ri ID' });
  try {
    const n = await pool.query(
      `UPDATE buyurtmalar SET holat = 'bekor_qilindi'
       WHERE id = $1 AND mijoz_id = $2 AND holat = 'kutilmoqda'
       RETURNING *`,
      [req.params.id, req.foydalanuvchi.id]
    );
    if (!n.rows.length) return res.status(404).json({ xato: 'Buyurtma topilmadi yoki bekor qilib bo\'lmaydi' });
    res.json({ muvaffaqiyat: true });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// ISH E'LONLARI
// ─────────────────────────────────────────────
app.get('/api/elonlar', async (req, res) => {
  const { kategoriya, sahifa, limit } = req.query;
  const sah = Math.max(1, parseInt(sahifa) || 1);
  const lim = Math.min(50, Math.max(1, parseInt(limit) || 10));
  const offset = (sah - 1) * lim;

  try {
    let sh = ["ie.holat = 'faol'"], q = [], i = 1;
    if (kategoriya && kategoriya !== 'barchasi') {
      sh.push(`ie.kategoriya = $${i++}`);
      q.push(kategoriya);
    }
    const shart = sh.join(' AND ');
    const sorov = `SELECT ie.*, f.ism AS mijoz_ismi, f.avatar_url AS mijoz_avatar
      FROM ish_elonlari ie
      JOIN foydalanuvchilar f ON f.id = ie.mijoz_id
      WHERE ${shart}
      ORDER BY ie.top_elon DESC, ie.yaratildi DESC
      LIMIT $${i} OFFSET $${i + 1}`;
    q.push(lim, offset);

    const [n, s] = await Promise.all([
      pool.query(sorov, q),
      pool.query(`SELECT COUNT(*) FROM ish_elonlari ie WHERE ${shart}`, q.slice(0, -2)),
    ]);
    res.json({ malumotlar: n.rows, jami: parseInt(s.rows[0].count) });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.post('/api/elonlar', tokenTekshir, async (req, res) => {
  const { sarlavha, kategoriya, tavsif, byudjet, top_elon } = req.body;
  if (!sarlavha || !kategoriya || !tavsif || !byudjet)
    return res.status(400).json({ xato: 'Barcha maydonlar majburiy' });
  if (isNaN(byudjet) || byudjet <= 0)
    return res.status(400).json({ xato: 'Byudjet musbat son bo\'lishi kerak' });

  try {
    const n = await pool.query(
      `INSERT INTO ish_elonlari (mijoz_id, sarlavha, kategoriya, tavsif, byudjet, top_elon)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.foydalanuvchi.id, sarlavha.trim(), kategoriya, tavsif.trim(), byudjet, top_elon || false]
    );
    res.status(201).json({ muvaffaqiyat: true, elon: n.rows[0] });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.post('/api/elonlar/:id/taklif', tokenTekshir, async (req, res) => {
  if (!uuidTekshir(req.params.id)) return res.status(400).json({ xato: 'Noto\'g\'ri ID' });
  const { matn, taklif_narx } = req.body;
  if (!matn || !matn.trim()) return res.status(400).json({ xato: 'Matn majburiy' });

  try {
    const [elon, usta] = await Promise.all([
      pool.query('SELECT * FROM ish_elonlari WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM usta_profillari WHERE foydalanuvchi_id = $1', [req.foydalanuvchi.id]),
    ]);

    if (!elon.rows.length) return res.status(404).json({ xato: 'E\'lon topilmadi' });
    if (!usta.rows.length) return res.status(400).json({ xato: 'Usta profili topilmadi' });
    if (elon.rows[0].mijoz_id === req.foydalanuvchi.id)
      return res.status(400).json({ xato: 'O\'z e\'loningizga taklif bera olmaysiz' });

    const n = await pool.query(
      `INSERT INTO taklifnomalar (elon_id, usta_id, mijoz_id, matn, taklif_narx)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, usta.rows[0].id, elon.rows[0].mijoz_id, matn.trim(), taklif_narx]
    );
    await pool.query('UPDATE ish_elonlari SET takliflar_soni = takliflar_soni + 1 WHERE id = $1', [req.params.id]);
    res.status(201).json({ muvaffaqiyat: true, taklif: n.rows[0] });
  } catch (x) {
    if (x.code === '23505') return res.status(400).json({ xato: 'Allaqachon taklif yuborgansiz' });
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.get('/api/elonlar/:id/takliflar', tokenTekshir, async (req, res) => {
  if (!uuidTekshir(req.params.id)) return res.status(400).json({ xato: 'Noto\'g\'ri ID' });
  try {
    const n = await pool.query(
      `SELECT t.*, up.mutaxassislik, up.reyting, f.ism AS usta_ismi, f.avatar_url
       FROM taklifnomalar t
       JOIN usta_profillari up ON up.id = t.usta_id
       JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id
       WHERE t.elon_id = $1 AND t.mijoz_id = $2
       ORDER BY t.yaratildi DESC`,
      [req.params.id, req.foydalanuvchi.id]
    );
    res.json(n.rows);
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.patch('/api/takliflar/:id/qabul', tokenTekshir, async (req, res) => {
  if (!uuidTekshir(req.params.id)) return res.status(400).json({ xato: 'Noto\'g\'ri ID' });
  try {
    // Faqat e'lon egasi qabul qila oladi
    const n = await pool.query(
      `UPDATE taklifnomalar SET holat = 'qabul_qilindi'
       WHERE id = $1 AND mijoz_id = $2 AND holat = 'kutilmoqda'
       RETURNING *`,
      [req.params.id, req.foydalanuvchi.id]
    );
    if (!n.rows.length) return res.status(404).json({ xato: 'Taklif topilmadi yoki allaqachon qayta ishlangan' });
    res.json({ muvaffaqiyat: true });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// BAHOLAR
// ─────────────────────────────────────────────
app.post('/api/baholar', tokenTekshir, async (req, res) => {
  const { buyurtma_id, ball, sharh } = req.body;
  if (!buyurtma_id || !ball) return res.status(400).json({ xato: 'Buyurtma ID va ball majburiy' });
  if (!uuidTekshir(buyurtma_id)) return res.status(400).json({ xato: 'Noto\'g\'ri buyurtma ID' });
  if (![1, 2, 3, 4, 5].includes(Number(ball))) return res.status(400).json({ xato: 'Ball 1-5 orasida bo\'lishi kerak' });

  try {
    const b = await pool.query(
      `SELECT * FROM buyurtmalar WHERE id = $1 AND mijoz_id = $2 AND holat = 'bajarildi'`,
      [buyurtma_id, req.foydalanuvchi.id]
    );
    if (!b.rows.length) return res.status(400).json({ xato: 'Faqat yakunlangan buyurtmalarni baholash mumkin' });

    const n = await pool.query(
      `INSERT INTO baholar (buyurtma_id, mijoz_id, usta_id, ball, sharh)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [buyurtma_id, req.foydalanuvchi.id, b.rows[0].usta_id, Number(ball), sharh?.trim()]
    );
    res.status(201).json({ muvaffaqiyat: true, baho: n.rows[0] });
  } catch (x) {
    if (x.code === '23505') return res.status(400).json({ xato: 'Bu buyurtmani allaqachon baholagansiz' });
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

// ─────────────────────────────────────────────
// TO'LOV — CLICK
// ─────────────────────────────────────────────
app.post('/api/tolov/yaratish', tokenTekshir, async (req, res) => {
  const { buyurtma_id, miqdor } = req.body;
  if (!buyurtma_id || !miqdor) return res.status(400).json({ xato: 'Buyurtma ID va miqdor majburiy' });
  if (!uuidTekshir(buyurtma_id)) return res.status(400).json({ xato: 'Noto\'g\'ri buyurtma ID' });
  if (isNaN(miqdor) || miqdor <= 0) return res.status(400).json({ xato: 'Miqdor musbat bo\'lishi kerak' });

  try {
    // Buyurtma foydalanuvchiga tegishliligini tekshir
    const b = await pool.query(
      'SELECT * FROM buyurtmalar WHERE id = $1 AND mijoz_id = $2',
      [buyurtma_id, req.foydalanuvchi.id]
    );
    if (!b.rows.length) return res.status(404).json({ xato: 'Buyurtma topilmadi' });

    const sid = `Y24-${buyurtma_id.slice(0, 8)}-${Date.now()}`;
    await pool.query(
      'INSERT INTO tolovlar (buyurtma_id, mijoz_id, miqdor, savdogar_trans_id) VALUES ($1, $2, $3, $4)',
      [buyurtma_id, req.foydalanuvchi.id, miqdor, sid]
    );
    const p = new URLSearchParams({
      service_id:        process.env.CLICK_SERVICE_ID  || '',
      merchant_id:       process.env.CLICK_MERCHANT_ID || '',
      amount:            miqdor,
      transaction_param: sid,
      return_url:        `${process.env.FRONTEND_URL || 'http://localhost:5000'}/tolov/natija`,
    });
    res.json({ muvaffaqiyat: true, tolov_url: 'https://my.click.uz/services/pay?' + p.toString() });
  } catch (x) {
    res.status(500).json({ xato: IS_PROD ? 'Server xatosi' : x.message });
  }
});

app.post('/api/tolov/click/prepare', async (req, res) => {
  try {
    if (!clickImzo(req.body)) return res.json({ error: -1, error_note: 'SIGN CHECK FAILED' });
    const t = await pool.query('SELECT * FROM tolovlar WHERE savdogar_trans_id = $1', [req.body.merchant_trans_id]);
    if (!t.rows.length) return res.json({ error: -5, error_note: 'TRANSACTION NOT FOUND' });
    if (t.rows[0].holat === 'bajarildi') return res.json({ error: -4, error_note: 'ALREADY PAID' });

    const pid = Date.now();
    await pool.query(
      `UPDATE tolovlar SET click_trans_id = $1, merchant_prepare_id = $2, holat = 'jarayonda'
       WHERE savdogar_trans_id = $3`,
      [req.body.click_trans_id, pid, req.body.merchant_trans_id]
    );
    res.json({
      click_trans_id:     parseInt(req.body.click_trans_id),
      merchant_trans_id:  req.body.merchant_trans_id,
      merchant_prepare_id: pid,
      error: 0, error_note: 'Success',
    });
  } catch (x) {
    console.error('click/prepare:', x.message);
    res.json({ error: -9, error_note: 'SERVER ERROR' });
  }
});

app.post('/api/tolov/click/complete', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!clickImzo(req.body)) return res.json({ error: -1, error_note: 'SIGN CHECK FAILED' });
    const t = await client.query('SELECT * FROM tolovlar WHERE savdogar_trans_id = $1', [req.body.merchant_trans_id]);
    if (!t.rows.length) return res.json({ error: -5, error_note: 'TRANSACTION NOT FOUND' });
    if (t.rows[0].holat === 'bajarildi') return res.json({ error: -4, error_note: 'ALREADY PAID' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE tolovlar SET holat = 'bajarildi', to_langan = NOW() WHERE savdogar_trans_id = $1`,
      [req.body.merchant_trans_id]
    );
    await client.query(
      `UPDATE buyurtmalar SET holat = 'qabul_qilindi' WHERE id = $1`,
      [t.rows[0].buyurtma_id]
    );
    await client.query('COMMIT');
    res.json({
      click_trans_id:     parseInt(req.body.click_trans_id),
      merchant_trans_id:  req.body.merchant_trans_id,
      merchant_confirm_id: t.rows[0].id,
      error: 0, error_note: 'Success',
    });
  } catch (x) {
    await client.query('ROLLBACK');
    console.error('click/complete:', x.message);
    res.json({ error: -9, error_note: 'SERVER ERROR' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// ADMIN ENDPOINTLAR
// ─────────────────────────────────────────────
app.get('/api/admin/statistika', adminTekshir, async (req, res) => {
  try {
    const [u, ust, b, t] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM foydalanuvchilar WHERE faol = TRUE`),
      pool.query(`SELECT COUNT(*) FROM usta_profillari`),
      pool.query(`SELECT COUNT(*), holat FROM buyurtmalar GROUP BY holat`),
      pool.query(`SELECT COALESCE(SUM(miqdor), 0) AS jami FROM tolovlar WHERE holat = 'bajarildi'`),
    ]);
    res.json({
      foydalanuvchilar: parseInt(u.rows[0].count),
      ustalar:          parseInt(ust.rows[0].count),
      buyurtmalar:      b.rows,
      jami_tolov:       parseInt(t.rows[0].jami),
    });
  } catch (x) {
    res.status(500).json({ xato: x.message });
  }
});

// ─────────────────────────────────────────────
// SPA — barcha yo'llar index.html ga
// ─────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ xato: 'Endpoint topilmadi' });
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// ─────────────────────────────────────────────
// GLOBAL XATO HANDLER
// ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Kutilmagan xato:', err.stack || err.message);
  res.status(500).json({ xato: IS_PROD ? 'Server xatosi yuz berdi' : err.message });
});

// ─────────────────────────────────────────────
// SERVERNI ISHGA TUSHIRISH
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 Yechim24.uz server ${PORT}-portda ishlamoqda`);
  console.log(`📌 Muhit: ${IS_PROD ? 'PRODUCTION' : 'development'}`);

  // DB ulanishini tekshir
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL ulanish muvaffaqiyatli');
  } catch (e) {
    console.error('❌ PostgreSQL ulanmadi:', e.message);
  }

 if (IS_PROD && process.env.ESKIZ_EMAIL) {
    await eskizTokenOlish();
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('⏹  Server to\'xtatilmoqda...');
  await pool.end();
  process.exit(0);
});
