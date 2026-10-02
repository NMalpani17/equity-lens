"""Environment-based configuration.

All runtime config is read here via pydantic-settings. Nothing else in the
service should read ``os.environ`` directly.
"""

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings, loaded from environment / ``.env``."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="AI_SERVICE_",
        extra="ignore",
    )

    app_name: str = "equity-lens-ai-service"
    environment: str = "development"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"
    # Comma-separated list of allowed CORS origins (the API gateway).
    cors_origins: str = "http://localhost:3001"

    # --- Market data ---
    # Finnhub is the primary quote provider; yfinance is the automatic fallback.
    finnhub_api_key: str = ""
    finnhub_base_url: str = "https://finnhub.io/api/v1"
    # How long (seconds) a quote is served from cache before refetching.
    market_cache_ttl_seconds: int = 60
    # HTTP timeout (seconds) for outbound provider requests.
    market_http_timeout_seconds: float = 5.0

    # --- Database (Supabase Postgres) ---
    # The RAG state tables are owned by Prisma (api/prisma) and accessed here via
    # psycopg. Read from the unprefixed DATABASE_URL (the hosting convention);
    # AI_SERVICE_DATABASE_URL also works.
    database_url: str = Field(
        default="",
        validation_alias=AliasChoices("AI_SERVICE_DATABASE_URL", "DATABASE_URL"),
    )
    db_pool_max_size: int = 5

    # --- Transcripts (Equibles) ---
    equibles_api_key: str = ""
    equibles_base_url: str = "https://api.equibles.com/v1"
    equibles_timeout_seconds: float = 20.0

    # --- Embeddings (Gemini) ---
    gemini_api_key: str = ""
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimension: int = 768
    embedding_batch_size: int = 100
    # Client-side cap on texts embedded per minute (each text counts as one
    # request on Gemini's free tier, limit 100/min). 0 disables the limiter.
    gemini_embed_texts_per_minute: int = 100
    # Client-side cap on estimated tokens embedded per minute; also the maximum
    # size of one batch. Free tier allows ~30k/min; the default leaves headroom
    # for the ~4 chars/token estimate. 0 disables.
    gemini_embed_tokens_per_minute: int = 24000

    # --- Vector index (Pinecone) ---
    pinecone_api_key: str = ""
    pinecone_index_name: str = "equity-lens-transcripts"
    pinecone_cloud: str = "aws"
    pinecone_region: str = "us-east-1"
    pinecone_namespace: str = "transcripts"
    # Namespace holding the same chunks embedded *without* context headers; only
    # the evaluation script uses it.
    pinecone_plain_namespace: str = "transcripts-noctx"
    pinecone_sparse_model: str = "pinecone-sparse-english-v0"
    pinecone_rerank_model: str = "bge-reranker-v2-m3"
    sparse_batch_size: int = 96
    upsert_batch_size: int = 100

    # --- RAG behaviour ---
    rag_quarters: int = 4
    rag_chunk_tokens: int = 400
    rag_chunk_overlap_tokens: int = 60
    rag_candidate_k: int = 25
    # Dense weight in the hybrid convex combination (sparse gets 1 - alpha).
    rag_hybrid_alpha: float = 0.75
    # New tickers ingested on demand per UTC day (Equibles allows 100 req/day
    # and one ticker costs about 5 requests).
    rag_daily_ingestion_cap: int = 8
    # An "indexing" job older than this is assumed dead and may be re-claimed.
    rag_stale_job_minutes: int = 30
    rag_ingestion_workers: int = 2
    rag_query_cache_size: int = 512
    rag_query_cache_ttl_seconds: int = 3600
    rag_max_retries: int = 5
    rag_retry_base_seconds: float = 1.0
    rag_retry_max_seconds: float = 30.0

    # --- Internal service auth ---
    # Shared secret the API gateway sends as X-Internal-Token (and as a bearer
    # token for /mcp). Chat and MCP endpoints reject requests without it.
    internal_token: str = ""

    # --- AI analyst chat ---
    # "provider:model" for LangChain's init_chat_model, so the provider is
    # swappable through config alone.
    chat_model: str = "google_genai:gemini-3.8-flash"
    # Gemini 3 thinking level (3.8 Flash supports low/medium/high, not minimal).
    chat_thinking_level: str = "low"
    # Includes thinking tokens on Gemini.
    chat_max_output_tokens: int = 2048
    chat_timeout_seconds: float = 60.0
    chat_max_model_calls: int = 6
    chat_max_tool_calls: int = 8
    chat_max_message_chars: int = 2000
    # History sent to the model: final answers only, newest first, capped.
    chat_history_max_messages: int = 6
    chat_history_max_tokens: int = 3000
    chat_search_top_k: int = 5
    # How long search_transcripts waits for on-demand indexing within a turn.
    chat_index_wait_seconds: float = 45.0

    # --- Tracing (Langfuse, optional) ---
    # Tracing is on only when both keys are set. Payloads are masked (portfolio
    # values, contact details, secrets) and user ids hashed before export.
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_base_url: str = "https://cloud.langfuse.com"
    # Fraction of turns traced (1.0 = all).
    langfuse_sample_rate: float = Field(default=1.0, ge=0.0, le=1.0)
    # Export timeout (whole seconds); export runs in a background thread.
    langfuse_timeout_seconds: int = Field(default=2, ge=1)
    langfuse_flush_interval_seconds: float = 5.0
    # HMAC key for hashing user ids in traces (plain SHA-256 if empty).
    trace_user_salt: str = ""

    @property
    def tracing_enabled(self) -> bool:
        """True when Langfuse credentials are configured."""
        return bool(self.langfuse_public_key and self.langfuse_secret_key)

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS origins as a list."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def chat_missing_settings(self) -> list[str]:
        """Names of required chat settings that are not configured."""
        missing = [] if self.internal_token else ["AI_SERVICE_INTERNAL_TOKEN"]
        if self.chat_model.startswith("google_genai:") and not self.gemini_api_key:
            missing.append("AI_SERVICE_GEMINI_API_KEY")
        return missing

    @property
    def rag_missing_settings(self) -> list[str]:
        """Names of required RAG settings that are not configured."""
        required = {
            "DATABASE_URL": self.database_url,
            "AI_SERVICE_EQUIBLES_API_KEY": self.equibles_api_key,
            "AI_SERVICE_GEMINI_API_KEY": self.gemini_api_key,
            "AI_SERVICE_PINECONE_API_KEY": self.pinecone_api_key,
        }
        return [name for name, value in required.items() if not value]


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
