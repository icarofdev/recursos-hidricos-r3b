from __future__ import annotations

import argparse
import datetime
import random
import time
from collections.abc import Iterator

import requests


DEFAULT_API_URL = "http://localhost:5000/api/data"


def generate_demo_readings(
    count: int = 48,
    seed: int = 42,
    interval_minutes: int = 30,
) -> Iterator[dict]:
    """Gera leituras determinísticas para demonstrações e testes manuais."""
    generator = random.Random(seed)
    capacidade_total = 150.0
    nivel_atual = 138.0
    start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        minutes=interval_minutes * max(count - 1, 0)
    )

    for index in range(count):
        if index and index % 18 == 0:
            nivel_atual = min(capacidade_total, nivel_atual + generator.uniform(34, 48))
        else:
            nivel_atual = max(8.0, nivel_atual - generator.uniform(0.4, 2.2))

        percentual = round((nivel_atual / capacidade_total) * 100, 1)
        volume = (100 * 100 * nivel_atual) / 1000.0
        timestamp = start + datetime.timedelta(minutes=interval_minutes * index)

        yield {
            "sensor_id": "ESP32_SIMULADO",
            "nivel_cm": round(nivel_atual, 2),
            "capacidade_cm": capacidade_total,
            "percentual": percentual,
            "volume_litros": round(volume, 2),
            "timestamp": timestamp.isoformat(),
        }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Envia leituras simuladas para a API do monitoramento hídrico."
    )
    parser.add_argument("--api-url", default=DEFAULT_API_URL)
    parser.add_argument("--count", type=int, default=12)
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    if arguments.count < 1:
        raise SystemExit("--count deve ser maior que zero.")
    if arguments.delay_seconds < 0:
        raise SystemExit("--delay-seconds não pode ser negativo.")

    print(f"Enviando {arguments.count} leituras para {arguments.api_url}...")
    for reading in generate_demo_readings(arguments.count, arguments.seed):
        payload = {key: value for key, value in reading.items() if key != "timestamp"}
        try:
            response = requests.post(arguments.api_url, json=payload, timeout=5)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise SystemExit(f"Falha ao enviar dados simulados: {exc}") from exc

        print(
            f"{response.status_code} · {payload['percentual']}% · "
            f"{payload['nivel_cm']} cm"
        )
        if arguments.delay_seconds:
            time.sleep(arguments.delay_seconds)


if __name__ == "__main__":
    main()
