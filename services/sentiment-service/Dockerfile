FROM python:3.11-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer caching for big ML deps)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download models at build time so startup is faster
RUN python -c "\
from transformers import pipeline; \
pipeline('sentiment-analysis', model='cardiffnlp/twitter-roberta-base-sentiment-latest'); \
pipeline('text-classification', model='unitary/toxic-bert'); \
print('Models downloaded successfully')"

# Copy application code
COPY . .

EXPOSE 5000

CMD ["python", "main.py"]
