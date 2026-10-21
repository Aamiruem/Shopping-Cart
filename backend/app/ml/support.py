"""Support ticket triage: category classifier, sentiment, priority and a suggested first reply.

- Category: TF-IDF (words + word pairs) -> logistic regression, trained on labelled example
  tickets (ml/support_data.py). Accuracy is measured with 5-fold cross-validation at start-up.
- Sentiment: a lexicon scorer that understands negation ("not happy") and intensifiers ("very late").
- Priority: combines sentiment, urgent phrases (fraud, charged twice...) and the category.
"""

import math
import re
from functools import lru_cache

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
from sklearn.pipeline import make_pipeline

from .support_data import CATEGORY_LABELS, REPLY_TEMPLATES, TRAINING_TICKETS

POSITIVE = {
    "thanks": 1.5,
    "thank": 1.5,
    "great": 2,
    "good": 1.5,
    "love": 2.5,
    "happy": 2,
    "excellent": 2.5,
    "awesome": 2.5,
    "helpful": 2,
    "quick": 1,
    "fast": 1,
    "perfect": 2.5,
    "satisfied": 2,
    "nice": 1.5,
    "appreciate": 2,
    "amazing": 2.5,
    "resolved": 1.5,
    "pleased": 2,
    "smooth": 1.5,
    "best": 2,
}
NEGATIVE = {
    "bad": -2,
    "worst": -3,
    "terrible": -3,
    "horrible": -3,
    "broken": -2,
    "damaged": -2,
    "defective": -2.5,
    "late": -1.5,
    "delay": -1.5,
    "delayed": -1.5,
    "angry": -2.5,
    "disappointed": -2.5,
    "poor": -2,
    "useless": -2.5,
    "waste": -2.5,
    "missing": -2,
    "wrong": -1.5,
    "fraud": -3.5,
    "scam": -3.5,
    "cheated": -3.5,
    "rude": -2.5,
    "frustrated": -2.5,
    "pathetic": -3,
    "fake": -2.5,
    "unacceptable": -3,
    "never": -1,
    "problem": -1,
    "issue": -0.8,
    "stuck": -1.5,
    "failed": -1.5,
    "charged": -0.5,
    "lost": -2,
    "ridiculous": -2.5,
    "annoyed": -2,
    "upset": -2,
}
NEGATIONS = {
    "not",
    "no",
    "never",
    "dont",
    "don't",
    "didnt",
    "didn't",
    "isnt",
    "isn't",
    "wasnt",
    "wasn't",
    "cant",
    "can't",
    "won't",
    "nothing",
}
INTENSIFIERS = {"very": 1.5, "extremely": 2.0, "really": 1.3, "so": 1.3, "totally": 1.5, "completely": 1.6, "too": 1.3}
URGENT = re.compile(
    r"\b(urgent|immediately|asap|fraud|scam|charged twice|double charged|(debited|deducted|charged) twice|"
    r"(money|amount) (got |was |has been )?(deducted|debited)|police|legal|consumer court|stolen|hacked|unauthori[sz]ed|"
    r"chargeback|not received|never (arrived|received|came))\b",
    re.I,
)
WORD = re.compile(r"[a-z']+")
CLAUSE_BREAK = re.compile(r"[.!?;,]+|\bbut\b")


@lru_cache(maxsize=1)
def _classifier():
    texts = [t for t, _ in TRAINING_TICKETS]
    labels = [c for _, c in TRAINING_TICKETS]

    def build():
        return make_pipeline(
            TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1, stop_words="english"),
            LogisticRegression(C=8, max_iter=2000, class_weight="balanced"),
        )

    accuracy = cross_val_score(build(), texts, labels, cv=5).mean()
    return build().fit(texts, labels), float(accuracy)


def classifier_info() -> dict:
    _, accuracy = _classifier()
    return {
        "model": "TF-IDF + logistic regression",
        "trainingExamples": len(TRAINING_TICKETS),
        "crossValidatedAccuracy": round(accuracy, 3),
        "categories": CATEGORY_LABELS,
    }


def classify(text: str) -> tuple[str, float]:
    model, _ = _classifier()
    proba = model.predict_proba([text])[0]
    best = int(np.argmax(proba))
    return str(model.classes_[best]), float(proba[best])


def sentiment(text: str) -> float:
    """-1 (very negative) .. +1 (very positive)."""
    total = 0.0
    # Negation and intensifiers only reach forward within the same clause:
    # in "still not credited. Very disappointed!" the "not" must not flip "disappointed".
    for clause in CLAUSE_BREAK.split(text.lower()):
        negate_left, boost = 0, 1.0
        for word in WORD.findall(clause):
            if word in NEGATIONS:
                negate_left = 3
                continue
            if word in INTENSIFIERS:
                boost = INTENSIFIERS[word]
                continue
            score = POSITIVE.get(word, NEGATIVE.get(word, 0.0))
            if score:
                if negate_left:
                    score = -score * 0.8
                total += score * boost
            boost = 1.0
            negate_left = max(0, negate_left - 1)
    shouting = sum(1 for w in re.findall(r"\b[A-Z]{3,}\b", text)) + text.count("!")
    if total < 0:
        total -= min(shouting, 4) * 0.5
    return round(math.tanh(total / 4), 3)


def priority(category: str, sentiment_score: float, text: str) -> str:
    points = 0
    points += 2 if sentiment_score <= -0.5 else 1 if sentiment_score <= -0.2 else 0
    points += 2 if URGENT.search(text) else 0
    points += 1 if category == "payment" else 0
    return "high" if points >= 3 else "medium" if points >= 1 else "low"


def triage(subject: str, message: str, customer_name: str = "there", order_id: int | None = None) -> dict:
    text = f"{subject}. {message}"
    category, confidence = classify(text)
    mood = sentiment(text)
    reply = REPLY_TEMPLATES[category].format(name=customer_name.split(" ")[0], order=f" #{order_id}" if order_id else "")
    if mood <= -0.4:
        reply = "We're really sorry about this experience. " + reply
    return {
        "category": category,
        "categoryLabel": CATEGORY_LABELS[category],
        "confidence": round(confidence, 3),
        "sentiment": mood,
        "priority": priority(category, mood, text),
        "suggestedReply": reply,
    }
