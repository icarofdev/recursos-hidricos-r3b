import requests
import time
import random
import datetime

# URL do seu backend local
URL = 'http://localhost:5000/api/data'

# Simulação de queda de nível
capacidade_total = 150.0
nivel_atual = 140.0 # Começa quase cheio

print("Iniciando envio de dados simulados...")
print("Pressione Ctrl+C para parar.")

try:
    while True:
        # Simula consumo de água (nível desce)
        consumo = random.uniform(0.1, 1.5)
        nivel_atual -= consumo
        
        if nivel_atual <= 10.0:
            # Reabastece o reservatório
            print("--- Reabastecendo reservatório ---")
            nivel_atual = capacidade_total
            
        percentual = int((nivel_atual / capacidade_total) * 100)
        volume = (100 * 100 * nivel_atual) / 1000.0 # 100x100 de base
        
        payload = {
            "sensor_id": "ESP32_SIMULADO",
            "nivel_cm": round(nivel_atual, 2),
            "capacidade_cm": capacidade_total,
            "percentual": percentual,
            "volume_litros": round(volume, 2)
        }
        
        try:
            response = requests.post(URL, json=payload)
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] POST Status: {response.status_code} | Nível: {percentual}% ({round(nivel_atual,2)}cm)")
        except requests.exceptions.ConnectionError:
            print("Erro de conexão! O servidor Flask está rodando na porta 5000?")
            
        # Espera 5 segundos antes de enviar o próximo dado (acelerado para testes)
        time.sleep(5)
        
except KeyboardInterrupt:
    print("\nSimulação parada pelo usuário.")
