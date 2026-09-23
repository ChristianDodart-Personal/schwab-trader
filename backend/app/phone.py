"""Optional outbound notification channel so bell alerts also reach a phone.

Two zero-to-cheap options:
  - ntfy.sh — POST the message to a topic URL (https://ntfy.sh/<your-topic>); the
    ntfy app on the phone subscribes to that topic. No account, no secret.
  - SMTP email — the user supplies host/port/user/password/from/to; many phones
    turn a starred sender into a push. Password is Fernet-encrypted at rest.

Fully OPTIONAL and best-effort: when the channel is off / unconfigured, or a send
fails for any reason, it degrades SILENTLY. The in-app bell + desktop notification
remain the source of truth — the phone channel is a courtesy copy, never a gate.

Config lives as a single Fernet-encrypted JSON blob in app_setting (same key/crypto
as the Schwab secret), so the SMTP password is never stored in cleartext.
"""
from __future__ import annotations

import asyncio
import json
import logging
import smtplib
import ssl
import urllib.request
from email.message import EmailMessage

from . import credentials

log = logging.getLogger(__name__)

_K_CFG = "phone_notify_cfg"  # Fernet-encrypted JSON blob

_DEFAULT: dict = {
    "channel": "off",       # "off" | "ntfy" | "email"
    "ntfy_url": "",         # e.g. https://ntfy.sh/my-secret-topic
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_pass": "",        # the only true secret in the blob
    "smtp_from": "",
    "smtp_to": "",
    "smtp_tls": True,       # STARTTLS on the submission port (ignored for 465 → implicit SSL)
}


async def get_config() -> dict:
    """Full config incl. the SMTP password (used only internally to send)."""
    raw = credentials._decrypt_secret(await credentials._raw_get(_K_CFG))
    if not raw:
        return dict(_DEFAULT)
    try:
        return {**_DEFAULT, **json.loads(raw)}
    except Exception:
        return dict(_DEFAULT)


async def set_config(patch: dict) -> dict:
    """Merge a partial update. A blank/absent smtp_pass keeps the stored one, so the
    UI never has to round-trip the secret (it's never sent to the browser)."""
    cfg = await get_config()
    for k in _DEFAULT:
        if k in patch and patch[k] is not None:
            cfg[k] = patch[k]
    # An empty password in the patch means "unchanged", not "clear it".
    if not (patch.get("smtp_pass") or "").strip():
        cfg["smtp_pass"] = (await get_config()).get("smtp_pass", "")
    try:
        cfg["smtp_port"] = int(cfg.get("smtp_port") or 587)
    except (TypeError, ValueError):
        cfg["smtp_port"] = 587
    await credentials._raw_set(_K_CFG, credentials._encrypt_secret(json.dumps(cfg)))
    return await status()


async def status() -> dict:
    """Secret-free view for the UI — everything EXCEPT the SMTP password, so the
    Settings form can prefill without ever exposing the stored secret."""
    cfg = await get_config()
    return {
        "channel": cfg["channel"],
        "ntfy_url": cfg["ntfy_url"],
        "ntfy_configured": bool(cfg["ntfy_url"]),
        "smtp_host": cfg["smtp_host"],
        "smtp_port": cfg["smtp_port"],
        "smtp_user": cfg["smtp_user"],
        "smtp_from": cfg["smtp_from"],
        "smtp_to": cfg["smtp_to"],
        "smtp_tls": cfg["smtp_tls"],
        "smtp_pass_set": bool(cfg["smtp_pass"]),
        "smtp_configured": bool(cfg["smtp_host"] and cfg["smtp_to"]),
    }


def _send_ntfy(url: str, title: str, message: str) -> None:
    # ntfy takes the body as the message; Title is a header (single line only).
    req = urllib.request.Request(
        url.strip(),
        data=message.encode("utf-8"),
        headers={"Title": title.replace("\n", " ")[:120], "Priority": "default"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=8).read()  # noqa: S310 (user-supplied topic URL)


def _send_email(cfg: dict, title: str, message: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = title.replace("\n", " ")[:150]
    msg["From"] = cfg["smtp_from"] or cfg["smtp_user"]
    msg["To"] = cfg["smtp_to"]
    msg.set_content(message)
    host, port = cfg["smtp_host"], int(cfg["smtp_port"] or 587)
    if port == 465:  # implicit SSL
        with smtplib.SMTP_SSL(host, port, timeout=12, context=ssl.create_default_context()) as s:
            if cfg["smtp_user"]:
                s.login(cfg["smtp_user"], cfg["smtp_pass"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=12) as s:
            if cfg.get("smtp_tls", True):
                s.starttls(context=ssl.create_default_context())
            if cfg["smtp_user"]:
                s.login(cfg["smtp_user"], cfg["smtp_pass"])
            s.send_message(msg)


def _send_sync(cfg: dict, title: str, message: str) -> None:
    ch = cfg.get("channel")
    if ch == "ntfy" and cfg.get("ntfy_url"):
        _send_ntfy(cfg["ntfy_url"], title, message)
    elif ch == "email" and cfg.get("smtp_host") and cfg.get("smtp_to"):
        _send_email(cfg, title, message)


async def send(title: str, message: str) -> None:
    """Fire-and-forget to the configured channel. Silent no-op when off/unconfigured.
    Swallows every error — must NEVER block or raise into the notification path."""
    try:
        cfg = await get_config()
        if cfg.get("channel", "off") == "off":
            return
        await asyncio.to_thread(_send_sync, cfg, title, message)
    except Exception as e:
        log.warning(f"send failed: {e!r}")


def dispatch(title: str, message: str) -> None:
    """Schedule a send without awaiting it, so a slow SMTP/ntfy never delays the in-app
    bell push. Whether a phone copy goes out at all was already decided by the unified
    delivery grid (notifications._gate) before this is called."""
    try:
        asyncio.create_task(send(title, message))
    except RuntimeError:
        pass  # no running loop (shouldn't happen in the async app) → skip


async def send_test() -> dict:
    """Attempt a send on the current config and report the outcome (for a Settings
    'Send test' button). Unlike `send`, this surfaces the error so the user can fix it."""
    cfg = await get_config()
    ch = cfg.get("channel", "off")
    if ch == "off":
        return {"ok": False, "error": "No channel selected."}
    if ch == "ntfy" and not cfg.get("ntfy_url"):
        return {"ok": False, "error": "ntfy topic URL is empty."}
    if ch == "email" and not (cfg.get("smtp_host") and cfg.get("smtp_to")):
        return {"ok": False, "error": "SMTP host and recipient are required."}
    try:
        await asyncio.to_thread(_send_sync, cfg, "Schwab Trader test",
                                "✅ Phone notifications are working.")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
