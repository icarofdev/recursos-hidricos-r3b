#include <ArduinoJson.h>
#include <WiFi.h>
#include <espMqttClient.h>

#include <atomic>
#include <math.h>
#include <string.h>

#include "secrets.h"

// --- Identidade e topicos MQTT ---
constexpr char DEVICE_ID[] = "ESP32_001";
constexpr char MQTT_CLIENT_ID[] = "sm-wa-ESP32_001";
constexpr char MQTT_DATA_TOPIC[] = "sm-wa/ESP32_001/data";
constexpr char MQTT_STATUS_TOPIC[] = "sm-wa/ESP32_001/status";
constexpr char MQTT_ONLINE_PAYLOAD[] =
    "{\"device_id\":\"ESP32_001\",\"status\":\"online\"}";
constexpr char MQTT_OFFLINE_PAYLOAD[] =
    "{\"device_id\":\"ESP32_001\",\"status\":\"offline\"}";

// --- Sensor HC-SR04 ---
constexpr int TRIG_PIN = 13;
constexpr int ECHO_PIN = 12;
constexpr int DISTANCIA_MIN_CM = 2;
constexpr int DISTANCIA_MAX_CM = 400;
constexpr unsigned long PULSE_TIMEOUT_US = 30000UL;

// --- Caixa d'agua ---
constexpr float ALTURA_CAIXA_CM = 150.0F;
constexpr float LARGURA_CAIXA_CM = 100.0F;
constexpr float COMPRIMENTO_CAIXA_CM = 100.0F;

// --- Temporizacao e MQTT ---
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr uint32_t MQTT_RECONNECT_INTERVAL_MS = 5000UL;
constexpr uint32_t PUBLISH_INTERVAL_MS = 30000UL;
constexpr uint16_t MQTT_KEEP_ALIVE_SECONDS = 15;
constexpr uint8_t MQTT_QOS = 1;

#if MQTT_USE_TLS
espMqttClientSecure mqttClient;
#else
espMqttClient mqttClient;
#endif

struct LeituraReservatorio {
    int distanciaVazioCm;
    float nivelAguaCm;
    float volumeLitros;
    int percentualNivel;
};

bool wifiConfigurado = false;
bool mqttConfigurado = false;
bool wifiEstavaConectado = false;
bool primeiraTentativaWifi = true;
bool primeiraTentativaMqtt = true;
std::atomic<bool> publicarAposConectar{false};
std::atomic<bool> mqttDesconectado{false};
uint32_t ultimaTentativaWifiMs = 0;
uint32_t ultimaTentativaMqttMs = 0;
uint32_t ultimaPublicacaoMs = 0;

bool intervaloDecorrido(uint32_t agora, uint32_t referencia, uint32_t intervalo) {
    return static_cast<uint32_t>(agora - referencia) >= intervalo;
}

bool contemPlaceholder(const char* valor) {
    return valor == nullptr || valor[0] == '\0' || strstr(valor, "SEU_") != nullptr ||
           strstr(valor, "SUA_") != nullptr;
}

bool validarConfiguracaoWifi() {
    if (contemPlaceholder(WIFI_SSID)) {
        Serial.println("[CONFIG] Defina WIFI_SSID em secrets.h.");
        return false;
    }
    return true;
}

bool validarConfiguracaoMqtt() {
    bool valida = true;

    if (contemPlaceholder(MQTT_HOST)) {
        Serial.println("[CONFIG] Defina MQTT_HOST em secrets.h.");
        valida = false;
    }
    if (MQTT_PORT == 0) {
        Serial.println("[CONFIG] MQTT_PORT deve ser maior que zero.");
        valida = false;
    }
    if (MQTT_PASSWORD[0] != '\0' && MQTT_USERNAME[0] == '\0') {
        Serial.println("[CONFIG] MQTT_USERNAME e obrigatorio quando ha senha MQTT.");
        valida = false;
    }
#if MQTT_USE_TLS
    if (MQTT_CA_CERT[0] == '\0') {
        Serial.println("[CONFIG] Defina MQTT_CA_CERT ao habilitar MQTT_USE_TLS.");
        valida = false;
    }
#endif

    return valida;
}

void onMqttConnect(bool sessionPresent) {
    Serial.print("[MQTT] Conectado. Sessao existente: ");
    Serial.println(sessionPresent ? "sim" : "nao");

    const uint16_t packetId =
        mqttClient.publish(MQTT_STATUS_TOPIC, MQTT_QOS, true, MQTT_ONLINE_PAYLOAD);
    if (packetId == 0) {
        Serial.println("[MQTT] Falha ao publicar status online.");
    } else {
        Serial.print("[MQTT] Status online retido. Packet ID: ");
        Serial.println(packetId);
    }

    publicarAposConectar.store(true);
}

void onMqttDisconnect(espMqttClientTypes::DisconnectReason reason) {
    Serial.print("[MQTT] Desconectado. Motivo: ");
    Serial.println(static_cast<int>(reason));

    mqttDesconectado.store(true);
}

void configurarMqtt() {
    mqttClient.onConnect(onMqttConnect);
    mqttClient.onDisconnect(onMqttDisconnect);
    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setClientId(MQTT_CLIENT_ID);
    mqttClient.setKeepAlive(MQTT_KEEP_ALIVE_SECONDS);
    mqttClient.setCleanSession(true);
    mqttClient.setWill(MQTT_STATUS_TOPIC, MQTT_QOS, true, MQTT_OFFLINE_PAYLOAD);

    if (MQTT_USERNAME[0] != '\0') {
        mqttClient.setCredentials(MQTT_USERNAME, MQTT_PASSWORD);
    }

#if MQTT_USE_TLS
    mqttClient.setCACert(MQTT_CA_CERT);
#endif
}

void tentarConectarWifi(uint32_t agora) {
    if (!wifiConfigurado || WiFi.status() == WL_CONNECTED) {
        return;
    }
    if (!primeiraTentativaWifi &&
        !intervaloDecorrido(agora, ultimaTentativaWifiMs, WIFI_RECONNECT_INTERVAL_MS)) {
        return;
    }

    primeiraTentativaWifi = false;
    ultimaTentativaWifiMs = agora;
    Serial.print("[WIFI] Conectando a ");
    Serial.println(WIFI_SSID);

    if (WIFI_PASSWORD[0] == '\0') {
        WiFi.begin(WIFI_SSID);
    } else {
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
}

void tentarConectarMqtt(uint32_t agora) {
    if (!mqttConfigurado || WiFi.status() != WL_CONNECTED ||
        !mqttClient.disconnected()) {
        return;
    }
    if (!primeiraTentativaMqtt &&
        !intervaloDecorrido(agora, ultimaTentativaMqttMs, MQTT_RECONNECT_INTERVAL_MS)) {
        return;
    }

    primeiraTentativaMqtt = false;
    ultimaTentativaMqttMs = agora;
    Serial.print("[MQTT] Conectando a ");
    Serial.print(MQTT_HOST);
    Serial.print(":");
    Serial.println(MQTT_PORT);

    if (!mqttClient.connect()) {
        Serial.println("[MQTT] Nao foi possivel iniciar a conexao.");
    }
}

bool medirReservatorio(LeituraReservatorio& leitura) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    const unsigned long duracao = pulseIn(ECHO_PIN, HIGH, PULSE_TIMEOUT_US);
    if (duracao == 0) {
        Serial.println("[SENSOR] Leitura invalida: timeout aguardando eco.");
        return false;
    }

    const float distanciaCalculadaCm = duracao * 0.0343F / 2.0F;
    if (!isfinite(distanciaCalculadaCm) || distanciaCalculadaCm < DISTANCIA_MIN_CM ||
        distanciaCalculadaCm > DISTANCIA_MAX_CM) {
        Serial.print("[SENSOR] Leitura fora da faixa do HC-SR04: ");
        Serial.print(distanciaCalculadaCm);
        Serial.println(" cm");
        return false;
    }

    leitura.distanciaVazioCm = static_cast<int>(distanciaCalculadaCm);
    leitura.nivelAguaCm = ALTURA_CAIXA_CM - leitura.distanciaVazioCm;
    if (leitura.nivelAguaCm < 0) {
        leitura.nivelAguaCm = 0;
    }
    if (leitura.nivelAguaCm > ALTURA_CAIXA_CM) {
        leitura.nivelAguaCm = ALTURA_CAIXA_CM;
    }

    leitura.percentualNivel =
        static_cast<int>((leitura.nivelAguaCm / ALTURA_CAIXA_CM) * 100.0F);
    leitura.volumeLitros =
        (LARGURA_CAIXA_CM * COMPRIMENTO_CAIXA_CM * leitura.nivelAguaCm) / 1000.0F;

    return true;
}

void exibirLeitura(const LeituraReservatorio& leitura) {
    Serial.print("[SENSOR] Distancia vazia: ");
    Serial.print(leitura.distanciaVazioCm);
    Serial.println(" cm");
    Serial.print("[SENSOR] Nivel de agua: ");
    Serial.print(leitura.nivelAguaCm);
    Serial.println(" cm");
    Serial.print("[SENSOR] Percentual: ");
    Serial.print(leitura.percentualNivel);
    Serial.println(" %");
    Serial.print("[SENSOR] Volume: ");
    Serial.print(leitura.volumeLitros);
    Serial.println(" litros");
}

void publicarLeitura() {
    if (!mqttClient.connected()) {
        return;
    }

    LeituraReservatorio leitura;
    if (!medirReservatorio(leitura)) {
        Serial.println("[MQTT] Publicacao ignorada por leitura invalida.");
        return;
    }

    exibirLeitura(leitura);

    StaticJsonDocument<256> documento;
    documento["device_id"] = DEVICE_ID;
    documento["nivel_cm"] = leitura.nivelAguaCm;
    documento["capacidade_cm"] = ALTURA_CAIXA_CM;
    documento["percentual"] = leitura.percentualNivel;
    documento["volume_litros"] = leitura.volumeLitros;

    char payload[256];
    if (measureJson(documento) + 1 > sizeof(payload)) {
        Serial.println("[MQTT] Payload excedeu o buffer local.");
        return;
    }
    serializeJson(documento, payload, sizeof(payload));

    const uint16_t packetId = mqttClient.publish(MQTT_DATA_TOPIC, MQTT_QOS, false, payload);
    if (packetId == 0) {
        Serial.println("[MQTT] Falha ao enfileirar leitura.");
        return;
    }

    Serial.print("[MQTT] Leitura publicada em ");
    Serial.print(MQTT_DATA_TOPIC);
    Serial.print(". Packet ID: ");
    Serial.println(packetId);
    Serial.print("[MQTT] Payload: ");
    Serial.println(payload);
}

void setup() {
    Serial.begin(115200);
    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    digitalWrite(TRIG_PIN, LOW);

    wifiConfigurado = validarConfiguracaoWifi();
    mqttConfigurado = validarConfiguracaoMqtt();
    configurarMqtt();

    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);

    tentarConectarWifi(millis());
}

void loop() {
    const uint32_t agora = millis();
    const bool wifiConectado = WiFi.status() == WL_CONNECTED;

    if (mqttDesconectado.exchange(false)) {
        ultimaTentativaMqttMs = agora;
        primeiraTentativaMqtt = false;
    }

    if (!wifiConectado) {
        if (wifiEstavaConectado) {
            Serial.println("[WIFI] Conexao perdida; aguardando reconexao.");
        }
        wifiEstavaConectado = false;
        tentarConectarWifi(agora);
        return;
    }

    if (!wifiEstavaConectado) {
        wifiEstavaConectado = true;
        primeiraTentativaMqtt = true;
        Serial.print("[WIFI] Conectado. IP: ");
        Serial.println(WiFi.localIP());
    }

    tentarConectarMqtt(agora);

    if (!mqttClient.connected()) {
        return;
    }

    if (publicarAposConectar.exchange(false) ||
        intervaloDecorrido(agora, ultimaPublicacaoMs, PUBLISH_INTERVAL_MS)) {
        ultimaPublicacaoMs = agora;
        publicarLeitura();
    }
}
