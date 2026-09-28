"""Business logic for health checks.

Kept separate from the router so the route layer only handles HTTP concerns.
"""

from app import __version__
from app.config import Settings
from app.models.health import HealthResponse


def get_health(settings: Settings) -> HealthResponse:
    """Return the current health status of the AI service."""
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=__version__,
        environment=settings.environment,
    )
