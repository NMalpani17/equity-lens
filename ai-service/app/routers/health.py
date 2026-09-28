"""Health-check route (HTTP layer only)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings
from app.models.health import HealthResponse
from app.services import health_service

router = APIRouter(tags=["health"])

SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get("/health", response_model=HealthResponse)
def health(settings: SettingsDep) -> HealthResponse:
    """Report whether the AI service is up."""
    return health_service.get_health(settings)
