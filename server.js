const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 5000;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'usta24',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const JWT_SECRET = process.env.JWT_SECRET || 'usta24-maxfiy-kalit';

function tokenTekshir(req, res, keyingi) {
  const sarlavha = req.headers.authorization;
  if (!sarlavha || !sarlavha.startsWith('Bearer '))
    return res.status(401).json({ xato: 'Tizimga kirish talab etiladi' });
  try {
    req.foydalanuvchi = jwt.verify(sarlavha.split(' ')[1], JWT_SECRET);
    keyingi();
  } catch (e) {
    res.status(401).json({ xato: 'Token yaroqsiz' });
  }
}

app.get('/salomatlik', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ holat: 'yaxshi', db: 'ulangan', server: 'Yechim24.uz', versiya: '1.0.0' });
  } catch (x) { res.status(500).json({ holat: 'xato', xabar: x.message }); }
});

app.get('/api/ustalar', async (req, res) => {
  const { kategoriya, top_rejim, qidiruv, sahifa, limit } = req.query;
  const sah = parseInt(sahifa) || 1;
  const lim = parseInt(limit) || 12;
  const offset = (sah - 1) * lim;
  try {
    let sh = ['f.faol = TRUE'], q = [], i = 1;
    if (kategoriya && kategoriya !== 'barchasi') {
      sh.push('up.kategoriya = $' + i++);
      q.push(kategoriya);
    }
    if (qidiruv) {
      sh.push('(f.ism ILIKE $' + i + ' OR up.mutaxassislik ILIKE $' + i + ')');
      q.push('%' + qidiruv + '%');
      i++;
    }
    const rejim = top_rejim || 'reyting';
    let t = 'up.reyting DESC, up.baholar_soni DESC';
    if (rejim === 'premium') t = 'up.oylik_tolov DESC, up.reyting DESC';
    else if (rejim === 'arzon') t = 'up.soatlik_narx ASC';
    else if (rejim === 'tajriba') t = 'up.tajriba_yil DESC';

    const shart = sh.join(' AND ');
    const sorov = 'SELECT up.id, up.kategoriya, up.mutaxassislik, up.tavsif, up.soatlik_narx, up.tajriba_yil, up.ko_nikmalar, up.joylashuv, up.mavjud, up.reyting, up.baholar_soni, up.bajarilgan_ishlar, up.oylik_tolov, up.premium, f.ism, f.avatar_url FROM usta_profillari up JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id WHERE ' + shart + ' ORDER BY ' + t + ' LIMIT $' + i + ' OFFSET $' + (i+1);
    q.push(lim, offset);
    const sonSorov = 'SELECT COUNT(*) FROM usta_profillari up JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id WHERE ' + shart;
    const [n, s] = await Promise.all([pool.query(sorov, q), pool.query(sonSorov, q.slice(0, -2))]);
    res.json({ malumotlar: n.rows, jami: parseInt(s.rows[0].count), sahifa: sah, jami_sahifalar: Math.ceil(s.rows[0].count / lim) });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.get('/api/ustalar/:id', async (req, res) => {
  try {
    const n = await pool.query('SELECT up.*, f.ism, f.avatar_url FROM usta_profillari up JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id WHERE up.id = $1 AND f.faol = TRUE', [req.params.id]);
    if (!n.rows.length) return res.status(404).json({ xato: 'Usta topilmadi' });
    res.json(n.rows[0]);
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/auth/sms-yuborish', async (req, res) => {
  const { telefon } = req.body;
  if (!/^\+998\d{9}$/.test(telefon)) return res.status(400).json({ xato: 'Telefon noto\'g\'ri' });
  try {
    const kod = Math.floor(100000 + Math.random() * 900000).toString();
    const muddati = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query('UPDATE otp_kodlar SET ishlatildi = TRUE WHERE telefon = $1', [telefon]);
    await pool.query('INSERT INTO otp_kodlar (telefon, kod, muddati) VALUES ($1, $2, $3)', [telefon, kod, muddati]);
    console.log('SMS: ' + telefon + ' -> ' + kod);
    res.json({ muvaffaqiyat: true, dev_kod: kod });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/auth/kod-tasdiqlash', async (req, res) => {
  const { telefon, kod, ism } = req.body;
  if (!telefon || !kod) return res.status(400).json({ xato: 'Telefon va kod majburiy' });
  try {
    const n = await pool.query('SELECT * FROM otp_kodlar WHERE telefon = $1 AND kod = $2 AND ishlatildi = FALSE AND muddati > NOW() ORDER BY yaratildi DESC LIMIT 1', [telefon, kod]);
    if (!n.rows.length) return res.status(400).json({ xato: 'Kod noto\'g\'ri' });
    await pool.query('UPDATE otp_kodlar SET ishlatildi = TRUE WHERE id = $1', [n.rows[0].id]);
    let f;
    const m = await pool.query('SELECT * FROM foydalanuvchilar WHERE telefon = $1', [telefon]);
    if (m.rows.length) {
      f = m.rows[0];
    } else {
      const y = await pool.query('INSERT INTO foydalanuvchilar (telefon, ism, tasdiqlangan) VALUES ($1, $2, TRUE) RETURNING *', [telefon, ism || 'Foydalanuvchi']);
      f = y.rows[0];
    }
    const token = jwt.sign({ id: f.id, telefon: f.telefon, rol: f.rol }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ muvaffaqiyat: true, token, foydalanuvchi: { id: f.id, ism: f.ism, telefon: f.telefon, rol: f.rol } });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/buyurtmalar', tokenTekshir, async (req, res) => {
  const { usta_id, sarlavha, tavsif, soat, manzil } = req.body;
  if (!usta_id || !sarlavha) return res.status(400).json({ xato: 'Usta va sarlavha majburiy' });
  try {
    const u = await pool.query('SELECT * FROM usta_profillari WHERE id = $1', [usta_id]);
    if (!u.rows.length) return res.status(404).json({ xato: 'Usta topilmadi' });
    const jami = u.rows[0].soatlik_narx * (soat || 1);
    const n = await pool.query('INSERT INTO buyurtmalar (mijoz_id, usta_id, sarlavha, tavsif, soat, jami_miqdor, manzil) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [req.foydalanuvchi.id, usta_id, sarlavha, tavsif, soat || 1, jami, manzil]);
    res.json({ muvaffaqiyat: true, buyurtma: n.rows[0] });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.get('/api/buyurtmalar', tokenTekshir, async (req, res) => {
  try {
    const n = await pool.query('SELECT b.*, up.mutaxassislik, f.ism AS usta_ismi FROM buyurtmalar b JOIN usta_profillari up ON up.id = b.usta_id JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id WHERE b.mijoz_id = $1 ORDER BY b.yaratildi DESC', [req.foydalanuvchi.id]);
    res.json(n.rows);
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.get('/api/elonlar', async (req, res) => {
  const { kategoriya, sahifa, limit } = req.query;
  const sah = parseInt(sahifa) || 1;
  const lim = parseInt(limit) || 10;
  const offset = (sah - 1) * lim;
  try {
    let sh = ["ie.holat = 'faol'"], q = [], i = 1;
    if (kategoriya && kategoriya !== 'barchasi') {
      sh.push('ie.kategoriya = $' + i++);
      q.push(kategoriya);
    }
    const shart = sh.join(' AND ');
    const sorov = 'SELECT ie.*, f.ism AS mijoz_ismi, f.avatar_url AS mijoz_avatar FROM ish_elonlari ie JOIN foydalanuvchilar f ON f.id = ie.mijoz_id WHERE ' + shart + ' ORDER BY ie.top_elon DESC, ie.yaratildi DESC LIMIT $' + i + ' OFFSET $' + (i+1);
    q.push(lim, offset);
    const sonSorov = 'SELECT COUNT(*) FROM ish_elonlari ie WHERE ' + shart;
    const [n, s] = await Promise.all([pool.query(sorov, q), pool.query(sonSorov, q.slice(0, -2))]);
    res.json({ malumotlar: n.rows, jami: parseInt(s.rows[0].count) });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/elonlar', tokenTekshir, async (req, res) => {
  const { sarlavha, kategoriya, tavsif, byudjet, top_elon } = req.body;
  if (!sarlavha || !kategoriya || !tavsif || !byudjet) return res.status(400).json({ xato: 'Barcha maydonlar majburiy' });
  try {
    const n = await pool.query('INSERT INTO ish_elonlari (mijoz_id, sarlavha, kategoriya, tavsif, byudjet, top_elon) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [req.foydalanuvchi.id, sarlavha, kategoriya, tavsif, byudjet, top_elon || false]);
    res.json({ muvaffaqiyat: true, elon: n.rows[0] });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/elonlar/:id/taklif', tokenTekshir, async (req, res) => {
  const { matn, taklif_narx } = req.body;
  if (!matn) return res.status(400).json({ xato: 'Matn majburiy' });
  try {
    const e = await pool.query('SELECT * FROM ish_elonlari WHERE id = $1', [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ xato: 'Elon topilmadi' });
    const u = await pool.query('SELECT * FROM usta_profillari WHERE foydalanuvchi_id = $1', [req.foydalanuvchi.id]);
    if (!u.rows.length) return res.status(400).json({ xato: 'Usta profili topilmadi' });
    const n = await pool.query('INSERT INTO taklifnomalar (elon_id, usta_id, mijoz_id, matn, taklif_narx) VALUES ($1, $2, $3, $4, $5) RETURNING *', [req.params.id, u.rows[0].id, e.rows[0].mijoz_id, matn, taklif_narx]);
    await pool.query('UPDATE ish_elonlari SET takliflar_soni = takliflar_soni + 1 WHERE id = $1', [req.params.id]);
    res.json({ muvaffaqiyat: true, taklif: n.rows[0] });
  } catch (x) {
    if (x.code === '23505') return res.status(400).json({ xato: 'Allaqachon taklif yuborgansiz' });
    res.status(500).json({ xato: x.message });
  }
});

app.get('/api/elonlar/:id/takliflar', tokenTekshir, async (req, res) => {
  try {
    const n = await pool.query('SELECT t.*, up.mutaxassislik, up.reyting, f.ism AS usta_ismi, f.avatar_url FROM taklifnomalar t JOIN usta_profillari up ON up.id = t.usta_id JOIN foydalanuvchilar f ON f.id = up.foydalanuvchi_id WHERE t.elon_id = $1 AND t.mijoz_id = $2 ORDER BY t.yaratildi DESC', [req.params.id, req.foydalanuvchi.id]);
    res.json(n.rows);
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.patch('/api/takliflar/:id/qabul', tokenTekshir, async (req, res) => {
  try {
    await pool.query("UPDATE taklifnomalar SET holat = 'qabul_qilindi' WHERE id = $1", [req.params.id]);
    res.json({ muvaffaqiyat: true });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

function clickImzo(p) {
  const h = crypto.createHash('md5').update(p.click_trans_id + p.service_id + (process.env.CLICK_SECRET_KEY || '') + p.merchant_trans_id + p.amount + p.action + p.sign_time).digest('hex');
  return h === p.sign_string;
}

app.post('/api/tolov/yaratish', tokenTekshir, async (req, res) => {
  const { buyurtma_id, miqdor } = req.body;
  try {
    const sid = 'U24-' + buyurtma_id + '-' + Date.now();
    await pool.query('INSERT INTO tolovlar (buyurtma_id, mijoz_id, miqdor, savdogar_trans_id) VALUES ($1, $2, $3, $4)', [buyurtma_id, req.foydalanuvchi.id, miqdor, sid]);
    const p = new URLSearchParams({ service_id: process.env.CLICK_SERVICE_ID || '', merchant_id: process.env.CLICK_MERCHANT_ID || '', amount: miqdor, transaction_param: sid, return_url: (process.env.FRONTEND_URL || 'http://localhost:5000') + '/tolov/natija' });
    res.json({ muvaffaqiyat: true, tolov_url: 'https://my.click.uz/services/pay?' + p.toString() });
  } catch (x) { res.status(500).json({ xato: x.message }); }
});

app.post('/api/tolov/click/prepare', async (req, res) => {
  if (!clickImzo(req.body)) return res.json({ error: -1, error_note: 'Imzo xato' });
  try {
    const t = await pool.query('SELECT * FROM tolovlar WHERE savdogar_trans_id = $1', [req.body.merchant_trans_id]);
    if (!t.rows.length) return res.json({ error: -5, error_note: 'Topilmadi' });
    const pid = Date.now();
    await pool.query("UPDATE tolovlar SET click_trans_id = $1, merchant_prepare_id = $2, holat = 'jarayonda' WHERE savdogar_trans_id = $3", [req.body.click_trans_id, pid, req.body.merchant_trans_id]);
    res.json({ click_trans_id: parseInt(req.body.click_trans_id), merchant_trans_id: req.body.merchant_trans_id, merchant_prepare_id: pid, error: 0, error_note: 'Success' });
  } catch (x) { res.json({ error: -9, error_note: 'Server xatosi' }); }
});

app.post('/api/tolov/click/complete', async (req, res) => {
  if (!clickImzo(req.body)) return res.json({ error: -1, error_note: 'Imzo xato' });
  try {
    const t = await pool.query('SELECT * FROM tolovlar WHERE savdogar_trans_id = $1', [req.body.merchant_trans_id]);
    if (!t.rows.length) return res.json({ error: -5, error_note: 'Topilmadi' });
    await pool.query('BEGIN');
    await pool.query("UPDATE tolovlar SET holat = 'bajarildi', to_langan = NOW() WHERE savdogar_trans_id = $1", [req.body.merchant_trans_id]);
    await pool.query("UPDATE buyurtmalar SET holat = 'qabul_qilindi' WHERE id = $1", [t.rows[0].buyurtma_id]);
    await pool.query('COMMIT');
    res.json({ click_trans_id: parseInt(req.body.click_trans_id), merchant_trans_id: req.body.merchant_trans_id, merchant_confirm_id: t.rows[0].id, error: 0, error_note: 'Success' });
  } catch (x) {
    await pool.query('ROLLBACK');
    res.json({ error: -9, error_note: 'Server xatosi' });
  }
});

app.use(function(x, req, res, next) { res.status(500).json({ xato: x.message }); });

app.listen(PORT, function() {
  console.log('Yechim24.uz server ' + PORT + '-portda ishlamoqda');
});
