import logging

from fastapi import APIRouter, Header
from httpx import AsyncClient

from api.core.const import ALLOWED_MODELS

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/models', tags=['models'])


async def _fetch_openai_models(api_key: str) -> list[str]:
    """Fetch gpt-5 model IDs from OpenAI."""
    try:
        async with AsyncClient() as client:
            response = await client.get(
                'https://api.openai.com/v1/models',
                headers={'Authorization': f'Bearer {api_key}'},
                timeout=10,
            )
            if response.status_code != 200:
                logger.warning('OpenAI /v1/models returned %s', response.status_code)
                return []
            data = response.json()
            return sorted(
                m['id'] for m in data.get('data', []) if m.get('id', '').startswith('gpt-5')
            )
    except Exception:
        logger.exception('Failed to fetch models from OpenAI')
        return []


@router.get('')
async def list_models(x_openai_key: str | None = Header(default=None)) -> list[str]:
    if x_openai_key:
        models = await _fetch_openai_models(x_openai_key)
        if models:
            return models
    return sorted(ALLOWED_MODELS)
