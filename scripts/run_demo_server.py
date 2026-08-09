from __future__ import annotations

import os
import sys
from pathlib import Path

import mongomock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app import create_app  # noqa: E402
from scripts.seed_demo_data import generate_demo_readings  # noqa: E402


demo_collection = mongomock.MongoClient()["recursos_hidricos"]["sensor_data"]
demo_collection.insert_many(list(generate_demo_readings()))
app = create_app(demo_collection)


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="127.0.0.1", port=port, debug=False)
