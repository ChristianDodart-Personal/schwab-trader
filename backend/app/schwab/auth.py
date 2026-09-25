"""Schwab OAuth via schwab-py.

The refresh token expires every 7 days, so the design is:
  - One-time interactive login (run `python -m app.schwab.authorize`) writes token.json.
  - After that, the long-running service loads token.json and schwab-py refreshes
    the access token automatically on each use. You only re-authorize when the
    7-day refresh token lapses (the authorize script handles that too).

We use the MANUAL flow because the registered callback is https://127.0.0.1/
(port 443), which would otherwise need an elevated local listener on Windows.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from ..config import settings

# Schwab's refresh token lapses 7 days after it's issued. token.json records the
# issuance moment as `creation_timestamp`; we surface how long until it expires so
# the UI can nag before the live feed silently drops to DEMO.
REFRESH_TOKEN_TTL_DAYS = 7
_REAUTH_CMD = "python -m app.schwab.authorize"

_cached_client = None

# Set when a live Schwab call is rejected for auth (e.g. the token was superseded by
# another instance sharing this app registration). The 7-day timestamp can still look
# valid, so token_status() must reflect this runtime truth. Cleared on reset_client()
# (re-auth / profile switch) and on any successful Schwab call.
_reauth_needed = False

# LIVENESS: the token file's 7-day timestamp says nothing about whether Schwab will
# actually honor the token right now (it can be silently superseded). So we track the
# result of the LAST real round-trip — from an active canary probe (get_account_numbers)
# or, for free, from the always-running quote stream. token_status() reports THIS, not
# just the timestamp. `at_mono` for freshness math; `at_iso` for display.
_last_probe: dict | None = None   # {ok, at_mono, at_iso, latency_ms, via, error}
_PROBE_TTL_S = 45.0               # a fresh success/failure is trusted this long


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _record_liveness(ok: bool, *, via: str, latency_ms: float | None = None,
                     error: str | None = None) -> None:
    global _last_probe, _reauth_needed
    _last_probe = {"ok": ok, "at_mono": time.monotonic(), "at_iso": _iso_now(),
                   "latency_ms": round(latency_ms) if latency_ms else None,
                   "via": via, "error": error}
    _reauth_needed = not ok


def mark_reauth_needed() -> None:
    global _reauth_needed
    _reauth_needed = True


def clear_reauth_needed() -> None:
    global _reauth_needed
    _reauth_needed = False


# The stream calls these — it authenticates against Schwab continuously, so a healthy
# stream is a free, real-time proof of life, and an auth-class stream error is proof of death.
def note_stream_live() -> None:
    _record_liveness(True, via="stream")


def note_stream_auth_error() -> None:
    _record_liveness(False, via="stream", error="stream rejected (auth)")


async def probe_live(force: bool = False) -> dict:
    """Actively confirm the token works RIGHT NOW via the cheapest authenticated call
    (get_account_numbers — tiny, read-only, no side effects). Cached for _PROBE_TTL_S;
    a recent stream heartbeat counts as fresh, so a healthy stream means zero extra calls."""
    import asyncio

    if not force and _last_probe and (time.monotonic() - _last_probe["at_mono"]) < _PROBE_TTL_S:
        return _last_probe
    client = get_client()
    if client is None:
        _record_liveness(False, via="probe", error="no token")
        return _last_probe

    def _call():
        t0 = time.perf_counter()
        r = client.get_account_numbers()
        return r.status_code, (time.perf_counter() - t0) * 1000.0

    try:
        code, ms = await asyncio.to_thread(_call)
        _record_liveness(code == 200, via="probe", latency_ms=ms,
                         error=None if code == 200 else f"HTTP {code}")
    except Exception as e:
        _record_liveness(False, via="probe", error=repr(e))
    return _last_probe


def token_status() -> dict:
    """Health of the ACTIVE profile's Schwab token (drives the re-auth banner). Reports
    the LAST verified round-trip (probe/stream), not just the token-file timestamp."""
    from .. import profiles

    st = profiles.profile_status(profiles.current_active_pid())
    p = _last_probe
    verified_live = bool(p and p["ok"])
    ago = int(time.monotonic() - p["at_mono"]) if p else None
    st = {**st,
          "verified_live": verified_live if p else None,
          "last_checked_at": p["at_iso"] if p else None,
          "last_checked_ago_s": ago,
          "latency_ms": p.get("latency_ms") if p else None,
          "check_source": p.get("via") if p else None}

    if _reauth_needed and st.get("authorized"):
        # Token timestamp looks fine but a real call was rejected — tell the truth.
        why = (p or {}).get("error")
        st.update({"authorized": False, "expired": True, "severity": "expired",
                   "message": "Schwab rejected the saved authorization — the token may have "
                              "been superseded by another device. Reconnect to go live."
                              + (f" (last check: {why})" if why else "")})
    elif verified_live and st.get("authorized"):
        # Positive confirmation: an authenticated call actually succeeded just now.
        lat = f" · {p['latency_ms']}ms" if p.get("latency_ms") else ""
        when = "just now" if (ago or 0) < 10 else f"{ago}s ago"
        st = {**st, "message": f"Live — Schwab verified {when}{lat}. " + st.get("message", "")}
    return st


def load_client():
    """Build a schwab-py client from the ACTIVE profile's ENCRYPTED token, or None.

    Never triggers interactive login — safe to call on server startup. Prefer
    get_client(); multiple independent clients race on token refresh rotation.
    """
    from schwab.auth import client_from_access_functions
    from .. import credentials, profiles

    pid = profiles.current_active_pid()
    if not profiles.has_token(pid):
        return None
    c = credentials.get()
    read_func, write_func = profiles.token_io(pid)
    try:
        return client_from_access_functions(
            c["client_id"], c["client_secret"], read_func, write_func, asyncio=False,
        )
    except Exception:
        return None


def get_client():
    """Return the single shared client (one token lifecycle for the whole app)."""
    global _cached_client
    if _cached_client is None:
        _cached_client = load_client()
    return _cached_client


def reset_client() -> None:
    """Drop the cached client (after re-auth or a profile switch) and the stale
    reauth-needed state — the next call re-probes against the fresh token."""
    global _cached_client, _reauth_needed
    _cached_client = None
    _reauth_needed = False
    # Drop avg52's and ladder_stats' failure backoff too — the dead token parked every
    # symbol for 5 min, so without this those columns stay blank for minutes after reconnect.
    from .. import avg52, ladder_stats
    avg52.reset_backoff()
    ladder_stats.reset_backoff()


def interactive_login():
    """Legacy one-time CLI browser login (manual flow) → token.json, which the
    first server boot migrates into the Default profile. In-app connect (per profile)
    is the primary path now; this uses .env creds since it runs outside the server."""
    from schwab.auth import client_from_manual_flow

    return client_from_manual_flow(
        api_key=settings.schwab_client_id,
        app_secret=settings.schwab_client_secret,
        callback_url=settings.schwab_callback_url,
        token_path=str(settings.token_path),
    )


# --- UI-driven re-authorization (the manual OAuth flow, split into two steps) ---
# Schwab's callback is https://127.0.0.1/ with no local listener, so the user must
# copy the redirect URL out of their browser and paste it back. We expose:
#   begin_reauth()  -> the authorization URL to visit (and stash the auth context)
#   complete_reauth(received_url) -> exchange the pasted URL for a token, persist it
_pending_auth_context = None


def begin_reauth() -> dict:
    """Step 1: produce the Schwab authorization URL for the user to open."""
    global _pending_auth_context
    from .. import credentials

    c = credentials.get()
    if not c["client_id"] or not c["client_secret"]:
        return {"ok": False, "error": "Schwab client id/secret aren't set — add them under Settings → Schwab API credentials."}
    from schwab.auth import get_auth_context

    ctx = get_auth_context(c["client_id"], c["callback_url"])
    _pending_auth_context = ctx
    return {"ok": True, "authorization_url": ctx.authorization_url,
            "callback_url": ctx.callback_url}


def complete_reauth(received_url: str) -> dict:
    """Step 2: exchange the pasted redirect URL for a fresh token + write it.

    Network-bound (token exchange) — call via asyncio.to_thread from async code.
    """
    global _pending_auth_context
    ctx = _pending_auth_context
    if ctx is None:
        return {"ok": False, "error": "No re-authorization in progress — start again."}
    received_url = (received_url or "").strip()
    if not received_url:
        return {"ok": False, "error": "Paste the full redirect URL from your browser's address bar."}
    if "code=" not in received_url:
        return {"ok": False, "error": "That URL has no authorization code — copy the ENTIRE address after you approve."}
    from schwab.auth import client_from_received_url
    from .. import credentials, profiles

    pid = profiles.current_active_pid()
    if not pid:
        return {"ok": False, "error": "No active profile to authorize."}
    c = credentials.get()
    _, write_func = profiles.token_io(pid)  # encrypts the fresh token for THIS profile
    try:
        client_from_received_url(
            c["client_id"], c["client_secret"],
            ctx, received_url, write_func,
        )
    except Exception as e:
        return {"ok": False, "error": f"Token exchange failed: {e}"}

    _pending_auth_context = None
    reset_client()  # next get_client() loads the fresh token
    return {"ok": True, **token_status()}
