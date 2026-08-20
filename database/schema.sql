CREATE DATABASE IF NOT EXISTS recursos_hidricos
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE recursos_hidricos;

CREATE TABLE IF NOT EXISTS devices (
    id BIGINT UNSIGNED NOT NULL,
    reported_status VARCHAR(16) NOT NULL DEFAULT 'offline',
    last_seen DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_devices_last_seen (last_seen),
    CONSTRAINT chk_devices_status CHECK (reported_status IN ('online', 'offline'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id BIGINT UNSIGNED NOT NULL,
    ppl DECIMAL(18, 4) NOT NULL,
    vazao DECIMAL(18, 4) NOT NULL,
    consumo DECIMAL(18, 4) NOT NULL,
    rssi_wifi DECIMAL(8, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (reading_id),
    KEY idx_readings_id_created (id, created_at, reading_id),
    KEY idx_readings_created (created_at, reading_id),
    CONSTRAINT fk_readings_device
        FOREIGN KEY (id) REFERENCES devices (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_readings_ppl CHECK (ppl >= 0),
    CONSTRAINT chk_readings_vazao CHECK (vazao >= 0),
    CONSTRAINT chk_readings_consumo CHECK (consumo >= 0),
    CONSTRAINT chk_readings_rssi CHECK (rssi_wifi >= -200 AND rssi_wifi <= 0)
) ENGINE=InnoDB;
