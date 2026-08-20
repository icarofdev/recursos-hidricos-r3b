#pragma once

#include <Arduino.h>

// Copie este arquivo para secrets.h e preencha apenas a copia local.
static constexpr char WIFI_SSID[] = "SEU_SSID";
static constexpr char WIFI_PASSWORD[] = "SUA_SENHA_WIFI";

static constexpr char MQTT_HOST[] = "SEU_BROKER_MQTT";
static constexpr uint16_t MQTT_PORT = 1883;
static constexpr char MQTT_USERNAME[] = "";
static constexpr char MQTT_PASSWORD[] = "";

// Use 0 para MQTT/TCP ou 1 para MQTT/TLS.
// Com TLS, normalmente use a porta 8883 e informe a CA raiz em formato PEM.
#define MQTT_USE_TLS 0
static constexpr char MQTT_CA_CERT[] = "";
