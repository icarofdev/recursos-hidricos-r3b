from __future__ import annotations

import datetime
import math
import os
from typing import Any

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import DESCENDING, MongoClient
from pymongo.errors import PyMongoError


load_dotenv()

MONGO_URI = os.getenv("MONGODB_URI") or os.getenv(
    "MONGO_URI", "mongodb://localhost:27017/"
)
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "recursos_hidricos")
MONGO_COLLECTION_NAME = os.getenv("MONGO_COLLECTION_NAME") or os.getenv(
    "MONGO_COLLECTION", "sensor_data"
)


class ValidationError(ValueError):
    def __init__(self, message: str, field: str | None = None):
        super().__init__(message)
        self.field = field


def create_collection():
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    return client[MONGO_DB_NAME][MONGO_COLLECTION_NAME]


def init_db(collection) -> None:
    try:
        collection.create_index([("timestamp", DESCENDING)])
    except PyMongoError as exc:
        print(f"Aviso: não foi possível inicializar índices do MongoDB: {exc}")


def serialize_document(document: dict[str, Any]) -> dict[str, Any]:
    serialized = dict(document)
    document_id = serialized.pop("_id", None)
    if document_id is not None:
        serialized["id"] = str(document_id)
    return serialized


def numeric_value(payload: dict[str, Any], field: str, default: float | None = None):
    value = payload.get(field, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError("O valor deve ser numérico.", field)
    if not math.isfinite(float(value)):
        raise ValidationError("O valor deve ser finito.", field)
    return value


def validate_reading(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("O corpo da requisição deve ser um objeto JSON.")

    for field in ("nivel_cm", "percentual"):
        if field not in payload:
            raise ValidationError("Campo obrigatório ausente.", field)

    nivel_cm = numeric_value(payload, "nivel_cm")
    capacidade_cm = numeric_value(payload, "capacidade_cm", 100)
    percentual = numeric_value(payload, "percentual")
    volume_litros = numeric_value(payload, "volume_litros", 0)

    if nivel_cm < 0:
        raise ValidationError("O valor não pode ser negativo.", "nivel_cm")
    if capacidade_cm <= 0:
        raise ValidationError("A capacidade deve ser maior que zero.", "capacidade_cm")
    if nivel_cm > capacidade_cm:
        raise ValidationError(
            "O nível não pode ser maior que a capacidade.", "nivel_cm"
        )
    if not 0 <= percentual <= 100:
        raise ValidationError("O percentual deve estar entre 0 e 100.", "percentual")
    if volume_litros < 0:
        raise ValidationError("O volume não pode ser negativo.", "volume_litros")

    sensor_id = payload.get("sensor_id", "unknown")
    if not isinstance(sensor_id, str) or not sensor_id.strip():
        raise ValidationError("O identificador deve ser um texto não vazio.", "sensor_id")
    if len(sensor_id) > 100:
        raise ValidationError("O identificador deve ter até 100 caracteres.", "sensor_id")

    return {
        "sensor_id": sensor_id.strip(),
        "nivel_cm": nivel_cm,
        "capacidade_cm": capacidade_cm,
        "percentual": percentual,
        "volume_litros": volume_litros,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def parse_integer_query(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = request.args.get(name)
    if raw_value is None:
        return default

    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValidationError("O valor deve ser um número inteiro.", name) from exc

    if not minimum <= value <= maximum:
        raise ValidationError(
            f"O valor deve estar entre {minimum} e {maximum}.", name
        )
    return value


def create_app(collection=None) -> Flask:
    flask_app = Flask(__name__, static_folder="static", static_url_path="/")
    CORS(flask_app)
    flask_app.config["SENSOR_COLLECTION"] = (
        collection if collection is not None else create_collection()
    )

    def current_collection():
        return flask_app.config["SENSOR_COLLECTION"]

    def database_error_response(exc: PyMongoError):
        print(f"Erro ao acessar MongoDB: {exc}")
        return jsonify({"status": "error", "message": "Erro ao acessar MongoDB."}), 503

    def validation_error_response(exc: ValidationError):
        response = {"status": "error", "message": str(exc)}
        if exc.field:
            response["field"] = exc.field
        return jsonify(response), 400

    @flask_app.get("/")
    def index():
        return flask_app.send_static_file("index.html")

    @flask_app.post("/api/data")
    def receive_data():
        try:
            document = validate_reading(request.get_json(silent=True))
        except ValidationError as exc:
            return validation_error_response(exc)

        try:
            result = current_collection().insert_one(document)
        except PyMongoError as exc:
            return database_error_response(exc)

        document["_id"] = result.inserted_id
        return (
            jsonify(
                {"status": "success", "data_received": serialize_document(document)}
            ),
            201,
        )

    @flask_app.get("/api/latest")
    def get_latest_data():
        try:
            document = current_collection().find_one(
                sort=[("timestamp", DESCENDING)]
            )
        except PyMongoError as exc:
            return database_error_response(exc)

        if document:
            return jsonify(serialize_document(document)), 200
        return jsonify({"message": "Nenhum dado encontrado."}), 404

    @flask_app.get("/api/history")
    def get_history():
        try:
            hours = parse_integer_query("hours", 24, 1, 744)
            limit = parse_integer_query("limit", 500, 1, 2000)
        except ValidationError as exc:
            return validation_error_response(exc)

        since = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(hours=hours)
        ).isoformat()

        try:
            cursor = (
                current_collection()
                .find({"timestamp": {"$gte": since}})
                .sort("timestamp", DESCENDING)
                .limit(limit)
            )
            data_list = [serialize_document(document) for document in cursor]
        except PyMongoError as exc:
            return database_error_response(exc)

        return jsonify(data_list), 200

    @flask_app.get("/api/alerts")
    def get_alerts():
        try:
            document = current_collection().find_one(
                projection={"percentual": True},
                sort=[("timestamp", DESCENDING)],
            )
        except PyMongoError as exc:
            return database_error_response(exc)

        alerts = []
        if document:
            percentual = document.get("percentual", 0)
            if percentual < 20:
                alerts.append(
                    {
                        "type": "critical",
                        "message": "Nível de água criticamente baixo (abaixo de 20%).",
                    }
                )
            elif percentual < 50:
                alerts.append(
                    {
                        "type": "warning",
                        "message": "Nível de água baixo (abaixo de 50%).",
                    }
                )

        return jsonify(alerts), 200

    return flask_app


app = create_app()


if __name__ == "__main__":
    init_db(app.config["SENSOR_COLLECTION"])
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
