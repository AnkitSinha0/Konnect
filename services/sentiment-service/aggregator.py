"""
aggregator.py – Sliding-window aggregation per group.
Uses Redis sorted sets for persistence (survives restarts).
Falls back to in-memory if Redis is unavailable.
"""

import time
import json
import redis as redis_lib
import os

WINDOW_SIZE = int(os.getenv("SLIDING_WINDOW_SIZE", "50"))
LOCK_COOLDOWN_SECONDS = 1800  # 30 minutes

# In-memory fallback
_in_memory_windows = {}  # groupId -> list of { toxicity, sentiment, timestamp }

# Redis client
_redis = None


def init_redis():
    """Initialize Redis connection for persistent sliding window."""
    global _redis
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        print("⚠️  No REDIS_URL – aggregator using in-memory only")
        return

    try:
        _redis = redis_lib.from_url(redis_url, decode_responses=True)
        _redis.ping()
        print("✅ Aggregator: Redis connected for sliding window persistence")
    except Exception as e:
        print(f"⚠️  Aggregator: Redis connection failed ({e}), using in-memory fallback")
        _redis = None


def _redis_key(group_id: str) -> str:
    return f"sentiment:window:{group_id}"


def _lock_key(group_id: str) -> str:
    return f"sentiment:lock:{group_id}"


def add_message_result(group_id: str, toxicity: float, sentiment_label: str, timestamp: float):
    """
    Add a single message analysis result to the group's sliding window.
    """
    entry = json.dumps({
        "toxicity": toxicity,
        "sentiment": sentiment_label,
        "ts": timestamp,
    })

    if _redis:
        try:
            key = _redis_key(group_id)
            # Add to sorted set (scored by timestamp)
            _redis.zadd(key, {entry: timestamp})
            # Trim to last N entries
            count = _redis.zcard(key)
            if count > WINDOW_SIZE:
                _redis.zremrangebyrank(key, 0, count - WINDOW_SIZE - 1)
            # Set TTL so stale groups don't persist forever (24h)
            _redis.expire(key, 86400)
            return
        except Exception as e:
            print(f"⚠️  Redis write failed, falling back to memory: {e}")

    # In-memory fallback
    if group_id not in _in_memory_windows:
        _in_memory_windows[group_id] = []
    window = _in_memory_windows[group_id]
    window.append({"toxicity": toxicity, "sentiment": sentiment_label, "ts": timestamp})
    if len(window) > WINDOW_SIZE:
        _in_memory_windows[group_id] = window[-WINDOW_SIZE:]


def get_group_stats(group_id: str) -> dict:
    """
    Compute aggregation stats for a group.
    Returns: { avg_toxicity, negative_ratio, moderation_score, mood, status }
    """
    entries = _get_window(group_id)

    if not entries:
        return {
            "avg_toxicity": 0.0,
            "negative_ratio": 0.0,
            "moderation_score": 0.0,
            "mood": "neutral",
            "status": "normal",
        }

    # Calculate averages
    total_toxicity = sum(e["toxicity"] for e in entries)
    avg_toxicity = total_toxicity / len(entries)

    # Count harmful negatives (negative AND toxicity > 0.3)
    # This filters out harmless self-expressive negative messages
    harmful_negative_count = sum(
        1 for e in entries
        if e["sentiment"] == "NEGATIVE" and e["toxicity"] > 0.3
    )
    negative_ratio = harmful_negative_count / len(entries)

    # Moderation score: weighted combination
    moderation_score = (0.7 * avg_toxicity) + (0.3 * negative_ratio)

    # Safety floor: if avg toxicity is very low, cap escalation
    if avg_toxicity < 0.2:
        moderation_score = min(moderation_score, 0.25)

    # Compute avg_sentiment using numeric mapping: +1 / 0 / -1
    _sentiment_value = {"POSITIVE": 1, "NEUTRAL": 0, "NEGATIVE": -1}
    avg_sentiment = sum(
        _sentiment_value.get(e["sentiment"], 0) for e in entries
    ) / len(entries)

    # Determine mood from sentiment distribution
    positive_count = sum(1 for e in entries if e["sentiment"] == "POSITIVE")
    neutral_count = sum(1 for e in entries if e["sentiment"] == "NEUTRAL")
    pos_ratio = positive_count / len(entries)
    neutral_ratio = neutral_count / len(entries)
    if pos_ratio > 0.6:
        mood = "positive"
    elif negative_ratio > 0.4:
        mood = "negative"
    elif neutral_ratio > 0.5:
        mood = "neutral"
    else:
        mood = "mixed"

    # Decision rules
    if moderation_score < 0.3:
        status = "normal"
    elif moderation_score < 0.6:
        status = "warning"
    elif moderation_score < 0.8:
        status = "notify_moderator"
    else:
        status = "auto_lock"

    return {
        "avg_toxicity": round(avg_toxicity, 4),
        "negative_ratio": round(negative_ratio, 4),
        "moderation_score": round(moderation_score, 4),
        "avg_sentiment": round(avg_sentiment, 4),
        "mood": mood,
        "status": status,
    }


def is_group_locked(group_id: str) -> bool:
    """Check if a group is currently locked (Redis TTL-based)."""
    if _redis:
        try:
            return _redis.exists(_lock_key(group_id)) == 1
        except Exception:
            pass
    return False


def get_lock_ttl(group_id: str) -> int:
    """Get remaining TTL (seconds) on a group lock. Returns 0 if not locked."""
    if _redis:
        try:
            ttl = _redis.ttl(_lock_key(group_id))
            return max(ttl, 0)
        except Exception:
            pass
    return 0


def lock_group(group_id: str):
    """Lock a group for LOCK_COOLDOWN_SECONDS (auto-expires via Redis TTL)."""
    if _redis:
        try:
            _redis.setex(_lock_key(group_id), LOCK_COOLDOWN_SECONDS, "locked")
            print(f"🔒 Group {group_id} auto-locked for {LOCK_COOLDOWN_SECONDS}s")
            return
        except Exception as e:
            print(f"⚠️  Failed to set lock in Redis: {e}")


def unlock_group(group_id: str):
    """Manually unlock a group (moderator action)."""
    if _redis:
        try:
            _redis.delete(_lock_key(group_id))
            print(f"🔓 Group {group_id} manually unlocked")
        except Exception:
            pass


def reset_window(group_id: str):
    """Clear the sliding window for a group (moderator reset)."""
    if _redis:
        try:
            _redis.delete(_redis_key(group_id))
            print(f"🔄 Group {group_id} sliding window reset (Redis)")
        except Exception as e:
            print(f"⚠️  Redis reset failed: {e}")
    # Also clear in-memory fallback
    _in_memory_windows.pop(group_id, None)


def _get_window(group_id: str) -> list:
    """Retrieve the sliding window entries for a group."""
    if _redis:
        try:
            key = _redis_key(group_id)
            raw_entries = _redis.zrange(key, 0, -1)
            return [json.loads(e) for e in raw_entries]
        except Exception as e:
            print(f"⚠️  Redis read failed: {e}")

    # In-memory fallback
    return _in_memory_windows.get(group_id, [])
