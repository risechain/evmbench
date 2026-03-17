"""Device-code OAuth flow for Codex (ChatGPT login).

Spawns `codex login --device-auth` in a temp HOME, parses the verification URL
and user code from its stdout, then polls for completion by checking whether
auth.json has appeared.
"""

import asyncio
import json
import logging
import re
import uuid
from pathlib import Path
import shutil
from tempfile import mkdtemp

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/auth/device', tags=['device-auth'])

_sessions: dict[str, '_DeviceSession'] = {}

_CODEX_BIN = 'codex'
_SESSION_TTL = 900  # 15 minutes


class _DeviceSession:
    __slots__ = ('id', 'home', 'process', 'verification_url', 'user_code', 'auth_tokens', 'error', '_task')

    def __init__(self, *, session_id: str, home: str) -> None:
        self.id = session_id
        self.home = home
        self.process: asyncio.subprocess.Process | None = None
        self.verification_url: str | None = None
        self.user_code: str | None = None
        self.auth_tokens: dict | None = None
        self.error: str | None = None
        self._task: asyncio.Task | None = None


class DeviceStartResponse(BaseModel):
    session_id: str
    verification_url: str
    user_code: str


class DevicePollResponse(BaseModel):
    status: str  # 'pending' | 'complete' | 'error'
    auth_tokens: dict | None = None
    error: str | None = None


async def _run_device_auth(session: _DeviceSession) -> None:
    """Background task: run codex login and wait for user to complete auth."""
    home = session.home
    try:
        proc = await asyncio.create_subprocess_exec(
            _CODEX_BIN, 'login', '--device-auth',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={
                'HOME': home,
                'PATH': '/usr/local/bin:/usr/bin:/bin',
            },
        )
        session.process = proc

        assert proc.stdout is not None
        output_lines: list[str] = []
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=_SESSION_TTL)
            except asyncio.TimeoutError:
                proc.kill()
                session.error = 'Timeout waiting for device auth'
                return

            if not raw:
                break
            line = raw.decode('utf-8', errors='replace').strip()
            # Strip ANSI escape codes
            line = re.sub(r'\x1b\[[0-9;]*m', '', line)
            output_lines.append(line)

            # Parse verification URL
            url_match = re.search(r'(https://\S+)', line)
            if url_match and 'openai.com' in url_match.group(1):
                session.verification_url = url_match.group(1)

            # Parse user code (pattern like XXXX-XXXXXX)
            code_match = re.search(r'\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b', line)
            if code_match:
                session.user_code = code_match.group(1)

        await proc.wait()

        # Check if auth.json was written
        auth_path = Path(home) / '.codex' / 'auth.json'
        if auth_path.exists():
            tokens = json.loads(auth_path.read_text(encoding='utf-8'))
            session.auth_tokens = tokens
            logger.info('Device auth session %s completed successfully', session.id)
        else:
            full_output = '\n'.join(output_lines)
            session.error = f'codex login exited with code {proc.returncode}: {full_output}'
            logger.warning('Device auth failed for session %s: %s', session.id, session.error)

    except Exception as exc:
        session.error = str(exc)
        logger.exception('Device auth session %s failed', session.id)


@router.post('/start')
async def start_device_auth() -> DeviceStartResponse:
    session_id = uuid.uuid4().hex[:16]
    # Use /var/tmp so codex doesn't complain about temp dir HOME
    base = Path('/var/tmp/evmbench-device')
    base.mkdir(parents=True, exist_ok=True)
    home = str(base / session_id)

    session = _DeviceSession(session_id=session_id, home=home)
    _sessions[session_id] = session

    # Start background task
    session._task = asyncio.create_task(_run_device_auth(session))

    # Wait briefly for the URL + code to appear in stdout
    for _ in range(50):  # up to 5 seconds
        await asyncio.sleep(0.1)
        if session.verification_url and session.user_code:
            break
        if session.error:
            break

    if not session.verification_url or not session.user_code:
        _sessions.pop(session_id, None)
        raise HTTPException(
            status_code=500,
            detail=session.error or 'Failed to start device auth — is codex installed?',
        )

    return DeviceStartResponse(
        session_id=session_id,
        verification_url=session.verification_url,
        user_code=session.user_code,
    )


@router.get('/{session_id}')
async def poll_device_auth(session_id: str) -> DevicePollResponse:
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail='Session not found or expired')

    if session.auth_tokens:
        _sessions.pop(session_id, None)
        return DevicePollResponse(status='complete', auth_tokens=session.auth_tokens)

    if session.error:
        _sessions.pop(session_id, None)
        return DevicePollResponse(status='error', error=session.error)

    return DevicePollResponse(status='pending')
