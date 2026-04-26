"""
main.py – Entry point for the Sentiment Analysis Service.
Loads models, connects Redis, starts Kafka consumer, and runs a Flask health endpoint.
"""

import os
import signal
import sys
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify
from model import load_models
from aggregator import init_redis, get_group_stats, is_group_locked, unlock_group
from consumer import start_consumer, stop_consumer

app = Flask(__name__)
PORT = int(os.getenv("PORT", "5000"))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "sentiment-service"}), 200


@app.route("/stats/<group_id>", methods=["GET"])
def group_stats(group_id):
    """Get current moderation stats for a group (for debugging / moderator dashboard)."""
    stats = get_group_stats(group_id)
    stats["locked"] = is_group_locked(group_id)
    stats["conversationId"] = group_id
    return jsonify(stats), 200


@app.route("/unlock/<group_id>", methods=["POST"])
def manual_unlock(group_id):
    """Moderator endpoint to manually unlock a group."""
    unlock_group(group_id)
    return jsonify({"status": "unlocked", "conversationId": group_id}), 200


def shutdown_handler(signum, frame):
    print("\n🛑 Shutting down sentiment service...")
    stop_consumer()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    print("=" * 50)
    print("🧠 Konnect Sentiment Analysis Service")
    print("=" * 50)

    # 1. Load ML models (one-time, takes ~30s)
    load_models()

    # 2. Connect Redis for aggregation persistence
    init_redis()

    # 3. Start Kafka consumer in background thread
    start_consumer()

    # 4. Start Flask health/debug server
    print(f"🚀 Sentiment service running on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
