-- Migration 0002: Perfis administrativos, ativação de dispositivos e suporte a SM-WU / SM-WA

-- 1. Coluna de papel em users (padrão 'user', sem autopromoção)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user'));

-- 2. Coluna de tipo obrigatório em devices ('SM-WU' medidor de nível, 'SM-WA' medidor de água/hidrômetro)
ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'SM-WU' CHECK(device_type IN ('SM-WU','SM-WA'));

-- 3. Tabela de códigos de ativação de uso único
CREATE TABLE activation_codes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL UNIQUE,
 created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 revoked_at INTEGER,
 revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL
);

CREATE INDEX idx_activation_device ON activation_codes(device_id, used_at, revoked_at);
CREATE INDEX idx_activation_hash ON activation_codes(code_hash);

-- 4. Trilha imutável de auditoria administrativa e de clientes
CREATE TABLE audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 action TEXT NOT NULL CHECK(action IN (
   'device_created',
   'code_generated',
   'code_revoked',
   'device_activated',
   'device_unlinked',
   'transfer_initiated',
   'transfer_completed',
   'device_updated'
 )),
 device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 details TEXT,
 ip TEXT,
 created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_device ON audit_logs(device_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);

-- 5. Tabela de leituras para medidores de água / hidrômetros SM-WA
CREATE TABLE smwa_readings (
 reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
 id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 reservoir_id INTEGER REFERENCES reservoirs(id) ON DELETE CASCADE,
 vazao REAL NOT NULL CHECK(vazao >= 0),
 consumo_acumulado REAL NOT NULL CHECK(consumo_acumulado >= 0),
 volume REAL CHECK(volume IS NULL OR volume >= 0),
 rssi_wifi REAL NOT NULL CHECK(rssi_wifi BETWEEN -200 AND 0),
 created_at INTEGER NOT NULL
);

CREATE INDEX idx_smwa_reservoir ON smwa_readings(reservoir_id, created_at DESC, reading_id DESC);
CREATE INDEX idx_smwa_device ON smwa_readings(id, created_at DESC);
