CREATE DATABASE IF NOT EXISTS recursos_hidricos
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE recursos_hidricos;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED NOT NULL,
    applied_at DATETIME NOT NULL,
    PRIMARY KEY (version)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    session_version INT UNSIGNED NOT NULL DEFAULT 1,
    last_login_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS devices (
    id BIGINT UNSIGNED NOT NULL,
    device_code VARCHAR(64) NULL,
    owner_user_id BIGINT UNSIGNED NULL,
    pairing_code_hash CHAR(64) NULL,
    pairing_expires_at DATETIME(6) NULL,
    paired_at DATETIME(6) NULL,
    reported_status VARCHAR(16) NOT NULL DEFAULT 'offline',
    last_seen DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_devices_last_seen (last_seen),
    UNIQUE KEY uq_devices_device_code (device_code),
    UNIQUE KEY uq_devices_pairing_hash (pairing_code_hash),
    KEY idx_devices_owner (owner_user_id),
    CONSTRAINT fk_devices_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT chk_devices_status CHECK (reported_status IN ('online', 'offline'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservoirs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    device_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(60) NOT NULL,
    capacity_liters DECIMAL(18, 4) NULL,
    linked_at DATETIME(6) NOT NULL,
    unlinked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_reservoirs_user_active (user_id, unlinked_at, id),
    KEY idx_reservoirs_device_active (device_id, unlinked_at, id),
    CONSTRAINT fk_reservoirs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_reservoirs_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE RESTRICT,
    CONSTRAINT chk_reservoir_capacity CHECK (capacity_liters IS NULL OR capacity_liters > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id BIGINT UNSIGNED NOT NULL,
    reservoir_id BIGINT UNSIGNED NULL,
    ppl DECIMAL(18, 4) NOT NULL,
    vazao DECIMAL(18, 4) NOT NULL,
    consumo DECIMAL(18, 4) NOT NULL,
    rssi_wifi DECIMAL(8, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (reading_id),
    KEY idx_readings_id_created (id, created_at, reading_id),
    KEY idx_readings_created (created_at, reading_id),
    KEY idx_sensor_reservoir_created (reservoir_id, created_at, reading_id),
    CONSTRAINT fk_readings_device
        FOREIGN KEY (id) REFERENCES devices (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_sensor_reservoir
        FOREIGN KEY (reservoir_id) REFERENCES reservoirs (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT chk_readings_ppl CHECK (ppl >= 0),
    CONSTRAINT chk_readings_vazao CHECK (vazao >= 0),
    CONSTRAINT chk_readings_consumo CHECK (consumo >= 0),
    CONSTRAINT chk_readings_rssi CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0)
) ENGINE=InnoDB;

-- Leituras do medidor ultrassonico SM-WU. A tabela legada acima e mantida para
-- preservar eventuais dados do SM-WA existentes na mesma instalacao.
CREATE TABLE IF NOT EXISTS smwu_readings (
    reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id BIGINT UNSIGNED NOT NULL,
    reservoir_id BIGINT UNSIGNED NULL,
    distancia DECIMAL(18, 4) NOT NULL,
    nivel DECIMAL(7, 4) NOT NULL,
    volume DECIMAL(18, 4) NOT NULL,
    rssi_wifi DECIMAL(8, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (reading_id),
    KEY idx_smwu_readings_id_created (id, created_at, reading_id),
    KEY idx_smwu_readings_created (created_at, reading_id),
    KEY idx_smwu_reservoir_created (reservoir_id, created_at, reading_id),
    CONSTRAINT fk_smwu_readings_device
        FOREIGN KEY (id) REFERENCES devices (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_smwu_reservoir
        FOREIGN KEY (reservoir_id) REFERENCES reservoirs (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT chk_smwu_readings_distancia CHECK (distancia >= 0),
    CONSTRAINT chk_smwu_readings_nivel CHECK (nivel >= 0 AND nivel <= 100),
    CONSTRAINT chk_smwu_readings_volume CHECK (volume >= 0),
    CONSTRAINT chk_smwu_readings_rssi CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    used_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_password_reset_hash (token_hash),
    KEY idx_password_reset_user (user_id, expires_at),
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash CHAR(64) NOT NULL,
    attempts INT UNSIGNED NOT NULL,
    window_started_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (key_hash),
    KEY idx_rate_limits_updated (updated_at)
) ENGINE=InnoDB;

INSERT IGNORE INTO schema_migrations (version, applied_at) VALUES (1, UTC_TIMESTAMP());
