"""Pydantic models for the health endpoint."""

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Health-check response payload."""

    status: str = Field(description="'ok' when the service is healthy.")
    service: str = Field(description="Name of this service.")
    version: str = Field(description="Service version.")
    environment: str = Field(description="Active runtime environment.")
