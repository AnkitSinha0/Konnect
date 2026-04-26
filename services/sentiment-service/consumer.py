"""
consumer.py – Kafka consumer that reads chat messages, runs ML inference,
updates the aggregator, and publishes results back to Kafka.
"""

import json
import time
import os
import threading
from kafka import KafkaConsumer, KafkaProducer
from kafka.errors import NoBrokersAvailable

from model import analyze_sentiment, analyze_toxicity
from aggregator import (
    add_message_result,
    get_group_stats,
    is_group_locked,
    lock_group,
    get_lock_ttl,
    LOCK_COOLDOWN_SECONDS,
)

KAFKA_BROKER = os.getenv("KAFKA_BROKER", "kafka:9092")
TOPIC_IN = os.getenv("KAFKA_TOPIC_IN", "chat_messages")
TOPIC_OUT = os.getenv("KAFKA_TOPIC_OUT", "sentiment_results")
GROUP_ID = os.getenv("KAFKA_GROUP_ID", "sentiment-consumer-group")

# Per-message toxicity threshold for immediate flagging.
# 0.8 catches directed insults/threats ("i fucking hate u", "kill yourself mate")
# while ignoring mild negativity and self-expression. Override via env if needed.
IMMEDIATE_FLAG_THRESHOLD = float(os.getenv("IMMEDIATE_FLAG_THRESHOLD", "0.8"))
# toxic-bert is unreliable on very short inputs (single words like "kill" spike
# falsely). Skip flagging for messages below this word count.
MIN_WORDS_FOR_FLAG = int(os.getenv("MIN_WORDS_FOR_FLAG", "3"))

_consumer = None
_producer = None
_running = False


def _connect_kafka(max_retries=10, retry_delay=5):
    """Connect to Kafka with retries (Kafka may take a while to start)."""
    global _consumer, _producer

    for attempt in range(1, max_retries + 1):
        try:
            print(f"🔄 Connecting to Kafka ({attempt}/{max_retries})...")
            _consumer = KafkaConsumer(
                TOPIC_IN,
                bootstrap_servers=[KAFKA_BROKER],
                group_id=GROUP_ID,
                auto_offset_reset="latest",
                enable_auto_commit=True,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
            )
            _producer = KafkaProducer(
                bootstrap_servers=[KAFKA_BROKER],
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            )
            print(f"✅ Kafka connected (broker: {KAFKA_BROKER})")
            return
        except NoBrokersAvailable:
            if attempt < max_retries:
                print(f"⏳ Kafka not ready, retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                raise RuntimeError("❌ Could not connect to Kafka after max retries")


def _process_message(data: dict):
    """Process a single chat message through the ML pipeline."""
    try:
        content = data.get("content", "")
        group_id = data.get("conversationId", "")
        message_id = data.get("messageId", "")
        sender_id = data.get("senderId", "")
        timestamp = data.get("timestamp", time.time())

        if not content or not group_id:
            return

        # Only analyze text messages
        if data.get("messageType", "text") != "text":
            return

        # Run ML inference
        sentiment_result = analyze_sentiment(content)
        toxicity_score = analyze_toxicity(content)

        print(
            f"📊 Message [{message_id[:8] if message_id else '?'}]: "
            f"sentiment={sentiment_result['label']} ({sentiment_result['score']:.2f}), "
            f"toxicity={toxicity_score:.4f}"
        )

        # Add to sliding window aggregator
        ts = time.time()
        add_message_result(group_id, toxicity_score, sentiment_result["label"], ts)

        # Get updated group stats
        stats = get_group_stats(group_id)

        # --- Per-message immediate flag ---
        # Only flag if score is high AND message is long enough to be reliable
        word_count = len(content.split())
        is_flagged = (
            toxicity_score >= IMMEDIATE_FLAG_THRESHOLD
            and word_count >= MIN_WORDS_FOR_FLAG
        )
        per_message_result = {
            "type": "per_message",
            "messageId": message_id,
            "conversationId": group_id,
            "senderId": sender_id,
            "sentiment": sentiment_result["label"],
            "sentiment_score": sentiment_result["score"],
            "toxicity": toxicity_score,
            "flagged": is_flagged,
            "timestamp": timestamp,
        }

        # --- Group aggregate result ---
        locked = is_group_locked(group_id)
        lock_ttl = get_lock_ttl(group_id) if locked else 0
        unlock_time = (time.time() + lock_ttl) if locked and lock_ttl > 0 else None

        group_result = {
            "type": "group_update",
            "conversationId": group_id,
            "avg_toxicity": stats["avg_toxicity"],
            "negative_ratio": stats["negative_ratio"],
            "moderation_score": stats["moderation_score"],
            "avg_sentiment": stats["avg_sentiment"],
            "mood": stats["mood"],
            "status": stats["status"],
            "locked": locked,
            "unlockTime": unlock_time,
            "timestamp": time.time(),
        }

        # Auto-lock if threshold exceeded and not already locked
        if stats["status"] == "auto_lock" and not group_result["locked"]:
            lock_group(group_id)
            group_result["locked"] = True
            group_result["unlockTime"] = time.time() + LOCK_COOLDOWN_SECONDS
            group_result["lock_event"] = True
            print(f"🔒 AUTO-LOCK triggered for group {group_id} "
                  f"(score: {stats['moderation_score']:.4f})")

        # Publish both results to Kafka output topic
        if _producer:
            _producer.send(TOPIC_OUT, value=per_message_result)
            _producer.send(TOPIC_OUT, value=group_result)
            _producer.flush()

    except Exception as e:
        print(f"❌ Error processing message: {e}")


def start_consumer():
    """Start the Kafka consumer loop in a background thread."""
    global _running

    _connect_kafka()
    _running = True

    def _consume_loop():
        print(f"🎧 Listening on Kafka topic: {TOPIC_IN}")
        while _running:
            try:
                for msg in _consumer:
                    if not _running:
                        break
                    _process_message(msg.value)
            except Exception as e:
                print(f"❌ Consumer error: {e}")
                if _running:
                    time.sleep(2)

    thread = threading.Thread(target=_consume_loop, daemon=True)
    thread.start()
    return thread


def stop_consumer():
    """Gracefully stop the consumer."""
    global _running
    _running = False
    if _consumer:
        _consumer.close()
    if _producer:
        _producer.close()
    print("🛑 Kafka consumer stopped")
