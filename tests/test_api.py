import mongomock
import pytest
from pymongo.errors import PyMongoError

from app import create_app


@pytest.fixture()
def collection():
    return mongomock.MongoClient()["test_recursos_hidricos"]["sensor_data"]


@pytest.fixture()
def client(collection):
    application = create_app(collection)
    application.config.update(TESTING=True)
    return application.test_client()


def valid_reading(**overrides):
    reading = {
        "sensor_id": "ESP32_TESTE",
        "nivel_cm": 75,
        "capacidade_cm": 150,
        "percentual": 50,
        "volume_litros": 750,
    }
    reading.update(overrides)
    return reading


def test_post_rejects_invalid_json(client):
    response = client.post("/api/data", data="não é json", content_type="text/plain")

    assert response.status_code == 400
    assert response.get_json()["message"] == (
        "O corpo da requisição deve ser um objeto JSON."
    )


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"percentual": 50}, "nivel_cm"),
        (valid_reading(percentual=101), "percentual"),
        (valid_reading(nivel_cm=-1), "nivel_cm"),
        (valid_reading(nivel_cm=151), "nivel_cm"),
        (valid_reading(volume_litros="muito"), "volume_litros"),
        (valid_reading(sensor_id=""), "sensor_id"),
    ],
)
def test_post_validates_reading_fields(client, payload, field):
    response = client.post("/api/data", json=payload)

    assert response.status_code == 400
    assert response.get_json()["field"] == field


def test_post_stores_and_returns_a_valid_reading(client, collection):
    response = client.post("/api/data", json=valid_reading())

    assert response.status_code == 201
    body = response.get_json()
    assert body["status"] == "success"
    assert body["data_received"]["sensor_id"] == "ESP32_TESTE"
    assert body["data_received"]["id"]
    assert collection.count_documents({}) == 1


def test_latest_returns_404_without_readings(client):
    response = client.get("/api/latest")

    assert response.status_code == 404
    assert response.get_json() == {"message": "Nenhum dado encontrado."}


def test_latest_and_history_return_stored_data(client):
    client.post("/api/data", json=valid_reading(percentual=67))

    latest = client.get("/api/latest")
    history = client.get("/api/history?hours=24&limit=10")

    assert latest.status_code == 200
    assert latest.get_json()["percentual"] == 67
    assert history.status_code == 200
    assert len(history.get_json()) == 1


@pytest.mark.parametrize("query", ["hours=zero", "hours=0", "limit=0", "limit=2001"])
def test_history_validates_query_parameters(client, query):
    response = client.get(f"/api/history?{query}")

    assert response.status_code == 400
    assert response.get_json()["field"] in {"hours", "limit"}


@pytest.mark.parametrize(
    ("percentual", "expected_type"),
    [(10, "critical"), (35, "warning")],
)
def test_alerts_reflect_the_latest_reading(client, percentual, expected_type):
    client.post("/api/data", json=valid_reading(percentual=percentual))

    response = client.get("/api/alerts")

    assert response.status_code == 200
    assert response.get_json()[0]["type"] == expected_type


def test_database_errors_return_503():
    class FailingCollection:
        def find_one(self, *args, **kwargs):
            raise PyMongoError("falha simulada")

    application = create_app(FailingCollection())
    application.config.update(TESTING=True)

    response = application.test_client().get("/api/latest")

    assert response.status_code == 503
    assert response.get_json() == {
        "status": "error",
        "message": "Erro ao acessar MongoDB.",
    }
