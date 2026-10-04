# ============================================================
# PRODUCTION DOCKERFILE FOR PYTHON FLASK APP
# ============================================================

FROM python:3.11-slim

WORKDIR /app

# Set production environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=5000 \
    TRADING_MODE=MOCK \
    LIVE_TRADING_ARMED=false \
    AUTO_TRADE_ENABLED=false

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Run as non-root user for security
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT:-5000}/api/health || exit 1

# Start production API server: 1 worker due to auto-trader lock
CMD ["sh", "-c", "gunicorn app:app --workers 1 --bind 0.0.0.0:${PORT:-5000} --timeout 60"]
