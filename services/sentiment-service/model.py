
from transformers import pipeline
import time

_sentiment_pipeline = None
_toxicity_pipeline = None

_LABEL_MAP = {
    "negative": "NEGATIVE",
    "neutral": "NEUTRAL",
    "positive": "POSITIVE",
}


def load_models():
    global _sentiment_pipeline, _toxicity_pipeline

    print("Loading twitter-roberta 3-class sentiment model...")
    start = time.time()
    _sentiment_pipeline = pipeline(
        "sentiment-analysis",
        model="cardiffnlp/twitter-roberta-base-sentiment-latest",
        top_k=None,
    )
    print(f"Sentiment model loaded in {time.time() - start:.1f}s")

    print("Loading toxic-bert toxicity model...")
    start = time.time()
    _toxicity_pipeline = pipeline(
        "text-classification",
        model="unitary/toxic-bert",
        top_k=None,
    )
    print(f"Toxicity model loaded in {time.time() - start:.1f}s")


def analyze_sentiment(text: str) -> dict:
    if _sentiment_pipeline is None:
        raise RuntimeError("Models not loaded – call load_models() first")

    results = _sentiment_pipeline(text[:512])[0]
    best = max(results, key=lambda r: r["score"])
    label = _LABEL_MAP.get(best["label"], best["label"].upper())
    return {"label": label, "score": round(best["score"], 4)}


def analyze_toxicity(text: str) -> float:
    if _toxicity_pipeline is None:
        raise RuntimeError("Models not loaded – call load_models() first")

    results = _toxicity_pipeline(text[:512])[0]
    toxic_labels = {"toxic", "severe_toxic", "obscene", "threat", "insult", "identity_hate"}
    toxic_score = 0.0
    for r in results:
        if r["label"] in toxic_labels and r["score"] > toxic_score:
            toxic_score = r["score"]
    return round(toxic_score, 4)
