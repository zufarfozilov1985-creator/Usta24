-- ================================================================
-- UstaBor.uz — Ma'lumotlar Bazasi Sxemasi (PostgreSQL)
-- ================================================================
-- Ishga tushirish:  psql -U postgres -d ustabor -f schema.sql
-- ================================================================

-- Kengaytmalar
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ────────────────────────────────────────────────────────────────
-- FOYDALANUVCHILAR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE foydalanuvchilar (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  telefon      VARCHAR(15) UNIQUE NOT NULL,       -- +998901234567
  ism          VARCHAR(100) NOT NULL,
  email        VARCHAR(255) UNIQUE,
  avatar_url   TEXT,
  rol          VARCHAR(20) DEFAULT 'mijoz'        -- 'mijoz' | 'usta' | 'admin'
               CHECK (rol IN ('mijoz','usta','admin')),
  tasdiqlangan BOOLEAN     DEFAULT FALSE,
  faol         BOOLEAN     DEFAULT TRUE,
  yaratildi    TIMESTAMPTZ DEFAULT NOW(),
  yangilandi   TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- OTP KODLAR (SMS tasdiqlash)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE otp_kodlar (
  id          SERIAL      PRIMARY KEY,
  telefon     VARCHAR(15) NOT NULL,
  kod         VARCHAR(6)  NOT NULL,
  ishlatildi  BOOLEAN     DEFAULT FALSE,
  muddati     TIMESTAMPTZ NOT NULL,
  yaratildi   TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- KATEGORIYALAR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE kategoriyalar (
  id          SERIAL      PRIMARY KEY,
  slug        VARCHAR(50) UNIQUE NOT NULL,
  nom         VARCHAR(100) NOT NULL,
  emoji       VARCHAR(10),
  tartib      INTEGER     DEFAULT 0
);

INSERT INTO kategoriyalar (slug, nom, emoji, tartib) VALUES
  ('santexnik',  'Santexnik',             '🔧', 1),
  ('elektrik',   'Elektrik',              '⚡', 2),
  ('dasturchi',  'Dasturchi',             '💻', 3),
  ('dizayner',   'Dizayner',              '🎨', 4),
  ('muallim',    'Muallim',               '📚', 5),
  ('haydovchi',  'Haydovchi',             '🚗', 6),
  ('tarjimon',   'Tarjimon',              '🌐', 7),
  ('oshpaz',     'Oshpaz',                '👨‍🍳', 8),
  ('shifokor',   'Shifokor (maslahat)',    '🏥', 9),
  ('boshqa',     'Boshqa',                '🔍', 10);

-- ────────────────────────────────────────────────────────────────
-- USTA PROFILLARI
-- ────────────────────────────────────────────────────────────────
CREATE TABLE usta_profillari (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  foydalanuvchi_id   UUID        NOT NULL REFERENCES foydalanuvchilar(id) ON DELETE CASCADE,
  kategoriya         VARCHAR(50) NOT NULL,
  mutaxassislik      VARCHAR(100) NOT NULL,         -- "Santexnik usta"
  tavsif             TEXT,
  soatlik_narx       INTEGER     NOT NULL,           -- so'm
  tajriba_yil        INTEGER     DEFAULT 0,
  ko_nikmalar        TEXT[],                         -- ['React','Node.js']
  joylashuv          VARCHAR(100),                   -- 'Toshkent, Chilonzor'
  kenglik            DECIMAL(9,6),                   -- GPS
  uzunlik            DECIMAL(9,6),
  portfolio_url      TEXT[],

  -- TOP REJIMI uchun asosiy ustun
  oylik_tolov        INTEGER     DEFAULT 0,          -- TOP (oylik) uchun to'lov miqdori (so'm)
  premium            BOOLEAN     DEFAULT FALSE,

  reyting            DECIMAL(3,2) DEFAULT 0.00,
  baholar_soni       INTEGER     DEFAULT 0,
  bajarilgan_ishlar  INTEGER     DEFAULT 0,
  mavjud             BOOLEAN     DEFAULT TRUE,
  yaratildi          TIMESTAMPTZ DEFAULT NOW(),
  yangilandi         TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(foydalanuvchi_id)
);

-- ────────────────────────────────────────────────────────────────
-- BUYURTMALAR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE buyurtmalar (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  mijoz_id        UUID        NOT NULL REFERENCES foydalanuvchilar(id),
  usta_id         UUID        NOT NULL REFERENCES usta_profillari(id),
  sarlavha        VARCHAR(255) NOT NULL,
  tavsif          TEXT,
  holat           VARCHAR(30) DEFAULT 'kutilmoqda'
                  CHECK (holat IN (
                    'kutilmoqda',      -- Yangi buyurtma
                    'qabul_qilindi',   -- Usta qabul qildi
                    'bajarilmoqda',    -- Ish boshlandi
                    'bajarildi',       -- Yakunlandi
                    'bekor_qilindi',   -- Bekor qilindi
                    'nizoli'           -- Nizo bor
                  )),
  soat            INTEGER     DEFAULT 1,
  jami_miqdor     INTEGER,               -- so'm
  manzil          TEXT,
  rejalashtirilgan TIMESTAMPTZ,
  yakunlangan      TIMESTAMPTZ,
  yaratildi        TIMESTAMPTZ DEFAULT NOW(),
  yangilandi       TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- TO'LOVLAR (Click integratsiyasi)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE tolovlar (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyurtma_id          UUID        NOT NULL REFERENCES buyurtmalar(id),
  mijoz_id             UUID        NOT NULL REFERENCES foydalanuvchilar(id),
  miqdor               INTEGER     NOT NULL,            -- so'm
  holat                VARCHAR(30) DEFAULT 'kutilmoqda'
                        CHECK (holat IN (
                          'kutilmoqda',    -- Yangi
                          'jarayonda',     -- Click PREPARE qabul qilindi
                          'bajarildi',     -- Click COMPLETE muvaffaqiyatli
                          'bekor_qilindi', -- Foydalanuvchi bekor qildi
                          'xato',          -- Xato yuz berdi
                          'qaytarildi'     -- Refund
                        )),
  -- Click API maydonlari
  savdogar_trans_id    VARCHAR(255) UNIQUE,             -- Bizning ID (UB-xxx-timestamp)
  merchant_prepare_id  BIGINT,                          -- PREPARE dan qaytgan ID
  click_trans_id       BIGINT      UNIQUE,              -- Click'ning tranzaksiya ID si
  click_paydoc_id      BIGINT,                          -- Click hujjat ID si
  to_lov_usuli         VARCHAR(30) DEFAULT 'click',
  xato_kodi            INTEGER     DEFAULT 0,
  xato_xabari          TEXT,
  to_langan            TIMESTAMPTZ,                     -- To'lov vaqti
  yaratildi            TIMESTAMPTZ DEFAULT NOW(),
  yangilandi           TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- BAHOLAR VA SHARHLAR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE baholar (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyurtma_id UUID        NOT NULL REFERENCES buyurtmalar(id),
  mijoz_id    UUID        NOT NULL REFERENCES foydalanuvchilar(id),
  usta_id     UUID        NOT NULL REFERENCES usta_profillari(id),
  ball        SMALLINT    NOT NULL CHECK (ball BETWEEN 1 AND 5),
  sharh       TEXT,
  yaratildi   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(buyurtma_id, mijoz_id)
);

-- ────────────────────────────────────────────────────────────────
-- PREMIUM TOP TOLOVLAR (oylik to'lov tarixi)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE premium_tolovlar (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  usta_id          UUID        NOT NULL REFERENCES usta_profillari(id),
  miqdor           INTEGER     NOT NULL,             -- so'm
  oy               DATE        NOT NULL,             -- 2025-01-01
  holat            VARCHAR(20) DEFAULT 'faol',
  tolov_id         UUID        REFERENCES tolovlar(id),
  yaratildi        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- INDEKSLAR (tezlashtirish)
-- ────────────────────────────────────────────────────────────────
CREATE INDEX idx_usta_kategoriya     ON usta_profillari(kategoriya);
CREATE INDEX idx_usta_reyting        ON usta_profillari(reyting DESC);
CREATE INDEX idx_usta_oylik_tolov    ON usta_profillari(oylik_tolov DESC);
CREATE INDEX idx_usta_joylashuv      ON usta_profillari(kenglik, uzunlik);
CREATE INDEX idx_usta_mavjud         ON usta_profillari(mavjud) WHERE mavjud = TRUE;
CREATE INDEX idx_buyurtmalar_mijoz   ON buyurtmalar(mijoz_id);
CREATE INDEX idx_buyurtmalar_usta    ON buyurtmalar(usta_id);
CREATE INDEX idx_buyurtmalar_holat   ON buyurtmalar(holat);
CREATE INDEX idx_tolovlar_holat      ON tolovlar(holat);
CREATE INDEX idx_tolovlar_click_id   ON tolovlar(click_trans_id);
CREATE INDEX idx_baholar_usta        ON baholar(usta_id);
CREATE INDEX idx_foydalanuvchi_trgm  ON foydalanuvchilar USING GIN (ism gin_trgm_ops);

-- ────────────────────────────────────────────────────────────────
-- TRIGGER: Reyting avtomatik yangilanishi
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reytingni_yangilash()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE usta_profillari
  SET
    reyting = COALESCE((
      SELECT ROUND(AVG(ball)::NUMERIC, 2) FROM baholar WHERE usta_id = NEW.usta_id
    ), 0),
    baholar_soni = (SELECT COUNT(*) FROM baholar WHERE usta_id = NEW.usta_id)
  WHERE id = NEW.usta_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reyting_yangilash
AFTER INSERT OR UPDATE ON baholar
FOR EACH ROW EXECUTE FUNCTION reytingni_yangilash();

-- ────────────────────────────────────────────────────────────────
-- TRIGGER: yangilandi avtomatik
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION yangilandi_ozgartir()
RETURNS TRIGGER AS $$
BEGIN NEW.yangilandi = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_foydalanuvchilar_yangilandi   BEFORE UPDATE ON foydalanuvchilar   FOR EACH ROW EXECUTE FUNCTION yangilandi_ozgartir();
CREATE TRIGGER trg_usta_profillari_yangilandi     BEFORE UPDATE ON usta_profillari    FOR EACH ROW EXECUTE FUNCTION yangilandi_ozgartir();
CREATE TRIGGER trg_buyurtmalar_yangilandi         BEFORE UPDATE ON buyurtmalar        FOR EACH ROW EXECUTE FUNCTION yangilandi_ozgartir();
CREATE TRIGGER trg_tolovlar_yangilandi            BEFORE UPDATE ON tolovlar           FOR EACH ROW EXECUTE FUNCTION yangilandi_ozgartir();

-- ────────────────────────────────────────────────────────────────
-- TRIGGER: Buyurtma yakunlananda usta ishlar sonini yangilash
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ishlar_sonini_yangilash()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.holat = 'bajarildi' AND OLD.holat != 'bajarildi' THEN
    UPDATE usta_profillari
    SET bajarilgan_ishlar = bajarilgan_ishlar + 1
    WHERE id = NEW.usta_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ishlar_soni
AFTER UPDATE ON buyurtmalar
FOR EACH ROW EXECUTE FUNCTION ishlar_sonini_yangilash();

-- ────────────────────────────────────────────────────────────────
-- NAMUNAVIY MA'LUMOTLAR
-- ────────────────────────────────────────────────────────────────
INSERT INTO foydalanuvchilar (id, telefon, ism, rol, tasdiqlangan) VALUES
  ('11111111-1111-1111-1111-111111111111', '+998901234567', 'Jasur Rahimov',   'usta', TRUE),
  ('22222222-2222-2222-2222-222222222222', '+998902345678', 'Dilnoza Yusupova','usta', TRUE),
  ('33333333-3333-3333-3333-333333333333', '+998903456789', 'Otabek Mirzayev', 'usta', TRUE),
  ('44444444-4444-4444-4444-444444444444', '+998904567890', 'Sarvinoz Qodirova','usta',TRUE);

INSERT INTO usta_profillari
  (foydalanuvchi_id, kategoriya, mutaxassislik, tavsif, soatlik_narx, tajriba_yil, ko_nikmalar, joylashuv, reyting, baholar_soni, bajarilgan_ishlar, oylik_tolov, premium, mavjud)
VALUES
  ('11111111-1111-1111-1111-111111111111','santexnik','Santexnik usta','7 yillik tajribam bor.',120000,7,ARRAY['Quvur ta''miri','Kran o''rnatish'],'Toshkent',4.9,214,412,500000,TRUE,TRUE),
  ('22222222-2222-2222-2222-222222222222','dasturchi','Veb dasturchi','Full-stack dasturchi.',350000,4,ARRAY['React','Node.js','PostgreSQL'],'Toshkent',4.8,89,156,800000,TRUE,TRUE),
  ('33333333-3333-3333-3333-333333333333','elektrik','Elektrik usta','10 yillik tajriba.',150000,10,ARRAY['Simsiz o''rnatish','Rozetka'],'Toshkent',4.9,341,689,350000,FALSE,FALSE),
  ('44444444-4444-4444-4444-444444444444','dizayner','UI/UX Dizayner','Figma eksperti.',280000,5,ARRAY['Figma','Prototyping'],'Toshkent',5.0,67,134,700000,TRUE,TRUE);
