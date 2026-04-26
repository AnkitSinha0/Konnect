"""
model.py – Load twitter-roberta (3-class sentiment) and toxic-bert (toxicity) once at startup.
Provides inference functions for individual messages.
"""

from transformers import pipeline
import time

# Global model references
_sentiment_pipeline = None
_toxicity_pipeline = None

# twitter-roberta-base-sentiment-latest uses label ids
_LABEL_MAP = {
    "negative": "NEGATIVE",
    "neutral": "NEUTRAL",
    "positive": "POSITIVE",
}


def load_models():
    """Load both ML models into memory. Call once at startup."""
    global _sentiment_pipeline, _toxicity_pipeline

    print("🔄 Loading twitter-roberta 3-class sentiment model...")
    start = time.time()
    _sentiment_pipeline = pipeline(
        "sentiment-analysis",
        model="cardiffnlp/twitter-roberta-base-sentiment-latest",
        top_k=None,  # return all labels with scores
    )
    print(f"✅ Sentiment model loaded in {time.time() - start:.1f}s")

    print("🔄 Loading toxic-bert toxicity model...")
    start = time.time()
    _toxicity_pipeline = pipeline(
        "text-classification",
        model="unitary/toxic-bert",
        top_k=None,
    )
    print(f"✅ Toxicity model loaded in {time.time() - start:.1f}s")


def analyze_sentiment(text: str) -> dict:
    """
    Returns { label: 'POSITIVE'|'NEGATIVE'|'NEUTRAL', score: float }
    Uses cardiffnlp/twitter-roberta-base-sentiment-latest (3-class).
    """
    if _sentiment_pipeline is None:
        raise RuntimeError("Models not loaded – call load_models() first")

    results = _sentiment_pipeline(text[:512])[0]  # truncate to model max
    # results is a list of dicts: [{'label': 'negative', 'score': 0.99}, ...]
    best = max(results, key=lambda r: r["score"])
    label = _LABEL_MAP.get(best["label"], best["label"].upper())
    return {"label": label, "score": round(best["score"], 4)}


def analyze_toxicity(text: str) -> float:
    """
    Returns toxicity score 0-1.
    toxic-bert returns multiple labels: 'toxic', 'severe_toxic', 'obscene',
    'threat', 'insult', 'identity_hate'. We take the MAX across all of them
    so insults/hate that aren't strictly "toxic" still flag.
    """
    if _toxicity_pipeline is None:
        raise RuntimeError("Models not loaded – call load_models() first")

    results = _toxicity_pipeline(text[:512])[0]
    # Max across all toxicity-related labels
    toxic_labels = {"toxic", "severe_toxic", "obscene", "threat", "insult", "identity_hate"}
    toxic_score = 0.0
    for r in results:
        if r["label"] in toxic_labels and r["score"] > toxic_score:
            toxic_score = r["score"]
    return round(toxic_score, 4)
