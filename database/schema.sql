CREATE DATABASE IF NOT EXISTS recursos_hidricos
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE recursos_hidricos;

CREATE TABLE IF NOT EXISTS devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    reported_status VARCHAR(16) NOT NULL DEFAULT 'offline',
    last_seen DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_devices_device_id (device_id),
    KEY idx_devices_last_seen (last_seen),
    CONSTRAINT chk_devices_status CHECK (reported_status IN ('online', 'offline'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sensor_readings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    nivel_cm DECIMAL(10, 2) NOT NULL,
    capacidade_cm DECIMAL(10, 2) NOT NULL,
    percentual DECIMAL(5, 2) NOT NULL,
    volume_litros DECIMAL(14, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_readings_device_created (device_id, created_at, id),
    KEY idx_readings_created (created_at, id),
    CONSTRAINT fk_readings_device
        FOREIGN KEY (device_id) REFERENCES devices (device_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT chk_readings_capacity CHECK (capacidade_cm > 0),
    CONSTRAINT chk_readings_level CHECK (nivel_cm >= 0 AND nivel_cm <= capacidade_cm),
    CONSTRAINT chk_readings_percentage CHECK (percentual >= 0 AND percentual <= 100),
    CONSTRAINT chk_readings_volume CHECK (volume_litros >= 0)
) ENGINE=InnoDB;

