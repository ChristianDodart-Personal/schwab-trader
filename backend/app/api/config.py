"""Configuration endpoints: per-account config + strategy, UI prefs, phone
notifications, signal rules, per-symbol rule overrides, and ETF links."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .. import accounts as accounts_svc
from .. import config_store
from .. import ledger as ledger_svc
from .. import notifications as notifications_svc
from .. import phone as phone_svc
from .. import profiles as profiles_svc
from ..main import strategy
from ._shared import _selected

router = APIRouter()


@router.get("/api/notif-prefs")
async def get_notif_prefs(account_hash: str | None = None) -> dict:
    """Notification delivery prefs for one account (mute, per-category channels, muted
    symbols). Defaults to the selected account; pass ?account_hash= to read another's.
    A brand-new account inherits the old global prefs so nothing feels reset."""
    acct = account_hash or (await _selected()) or None
    return await notifications_svc.get_notif_prefs(acct)


class NotifPrefsBody(BaseModel):
    muted: bool | None = None
    categories: dict | None = None
    muted_symbols: list[str] | None = None
    account_hash: str | None = None   # which account to write (default: selected)


@router.post("/api/notif-prefs")
async def set_notif_prefs(body: NotifPrefsBody) -> dict:
    data = body.model_dump(exclude_none=True)
    acct = data.pop("account_hash", None) or (await _selected()) or None
    return await notifications_svc.set_notif_prefs(data, account_hash=acct)


@router.get("/api/accounts-overview")
async def accounts_overview() -> dict:
    """Per-profile account columns for the multi-account hub / compare views.

    The ACTIVE profile lists its LIVE accounts (labeled by mask + type). Other profiles
    show their last-selected account from the local DB with a degraded (masked-hash)
    label — their live account list needs that profile's Schwab token, which only the
    active login holds. Rules and notification prefs are all local, so every listed
    account can still be read/edited without switching profiles."""
    profs = (await profiles_svc.list_profiles())["profiles"]
    active = await accounts_svc.list_accounts()   # active profile's live accounts
    sel_hash = active.get("selected_hash")
    out = []
    for p in profs:
        if p["active"]:
            accts = [
                {"hash": a["hash"],
                 "label": a["mask"] + (f" · {a['type']}" if a.get("type") else ""),
                 "selected": a["hash"] == sel_hash, "live": True}
                for a in active.get("accounts", [])
            ]
        else:
            sel = await profiles_svc._raw_get(f"p:{p['id']}:{accounts_svc.SELECTED_KEY}")
            accts = ([{"hash": sel, "label": f"…{sel[-4:]}", "selected": True, "live": False}]
                     if sel else [])
        out.append({"id": p["id"], "name": p["name"], "active": p["active"],
                    "connected": p["connected"], "accounts": accts})
    return {"profiles": out}


@router.get("/api/strategy/validate")
async def validate_strategy() -> dict:
    """Advisory sanity checks on the SELECTED account's strategy config (never blocks)."""
    from ..strategy import validate as strategy_validate

    cfg = await config_store.get_strategy(await _selected())
    return {"findings": strategy_validate.check(cfg.to_mapping())}


@router.get("/api/strategy")
async def get_strategy() -> dict:
    """Expose the loaded (malleable) strategy config to the UI."""
    return {
        "sizing_tiers": [t.__dict__ for t in strategy.sizing_tiers],
        "max_rungs": strategy.max_rungs,
        "ladder_drops": [d.__dict__ for d in strategy.ladder_drops],
        "sell": strategy.sell.__dict__,
        "guardrails": strategy.guardrails,
    }


class PhoneNotifyBody(BaseModel):
    channel: str | None = None       # "off" | "ntfy" | "email"
    ntfy_url: str | None = None
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_user: str | None = None
    smtp_pass: str | None = None     # blank = keep the stored one
    smtp_from: str | None = None
    smtp_to: str | None = None
    smtp_tls: bool | None = None


@router.get("/api/phone-notify")
async def get_phone_notify() -> dict:
    """Phone-notification config, secret-free (never returns the SMTP password)."""
    return await phone_svc.status()


@router.post("/api/phone-notify")
async def set_phone_notify(body: PhoneNotifyBody) -> dict:
    """Save the optional phone channel (ntfy topic or SMTP; password Fernet-encrypted)."""
    return await phone_svc.set_config(body.model_dump(exclude_none=True))


@router.post("/api/phone-notify/test")
async def test_phone_notify() -> dict:
    """Send a test message on the current config and report success/failure."""
    return await phone_svc.send_test()


class ConfigBody(BaseModel):
    tax_filing: str | None = None
    tax_state_rate: float | None = None
    strategy: dict | None = None
    # Ledger predictive inputs — nullable (can be cleared). We use model_fields_set
    # below so an OMITTED field is left as-is while an explicit null clears it.
    year_end_goal: float | None = None
    other_annual_income: float | None = None
    account_hash: str | None = None   # which account to write (default: selected)


@router.get("/api/config")
async def get_config(account_hash: str | None = None) -> dict:
    """Per-account config (strategy + trading-enable + tax). Defaults to the selected
    account; pass ?account_hash= to read another's (for the multi-account compare view).
    Rules live in the local DB, so any account's config reads without its Schwab token."""
    return await config_store.get_config(account_hash or await _selected())


@router.post("/api/config")
async def post_config(body: ConfigBody) -> dict:
    # Only forward the nullable ledger fields when the caller actually included them,
    # so a partial POST (e.g. just the goal from the ledger) doesn't wipe the other.
    extra = {}
    fs = body.model_fields_set
    if "year_end_goal" in fs:
        extra["year_end_goal"] = body.year_end_goal
    if "other_annual_income" in fs:
        extra["other_annual_income"] = body.other_annual_income
    return await config_store.set_config(
        body.account_hash or await _selected(),
        tax_filing=body.tax_filing,
        tax_state_rate=body.tax_state_rate, strategy=body.strategy, **extra,
    )


class PrefBody(BaseModel):
    value: Any = None


@router.get("/api/prefs/{key}")
async def get_pref(key: str) -> dict:
    """Per-PROFILE UI preference (e.g. column layouts), JSON-decoded. Scoped to the
    active profile so each profile keeps its own layout; persists in the DB."""
    raw = await accounts_svc.get_setting(profiles_svc.pkey(f"uipref:{key}"))
    try:
        return {"key": key, "value": json.loads(raw) if raw else None}
    except (ValueError, TypeError):
        return {"key": key, "value": None}


@router.post("/api/prefs/{key}")
async def set_pref(key: str, body: PrefBody) -> dict:
    await accounts_svc.set_setting(profiles_svc.pkey(f"uipref:{key}"), json.dumps(body.value))
    return {"ok": True}


# --- GLOBAL appearance (theme + font size) -------------------------------------
# Deliberately NOT profile-scoped (unlike /api/prefs): a display choice shouldn't
# flip when you switch profiles. And it MUST live in the DB, not localStorage — the
# packaged app binds a fresh random port each launch, so the renderer's origin (and
# thus its localStorage) changes every session; localStorage-only prefs reset every
# time. This is the same reason column layouts are DB-backed.
_APPEARANCE_THEME_KEY = "ui:appearance:theme"
_APPEARANCE_FONTSIZE_KEY = "ui:appearance:fontsize"


@router.get("/api/appearance")
async def get_appearance() -> dict:
    """The saved theme + font size (global). Null when never set — the client keeps
    its own default (Follow system / Small)."""
    return {
        "theme": await accounts_svc.get_setting(_APPEARANCE_THEME_KEY) or None,
        "fontsize": await accounts_svc.get_setting(_APPEARANCE_FONTSIZE_KEY) or None,
    }


class AppearanceBody(BaseModel):
    theme: str | None = None
    fontsize: str | None = None


@router.post("/api/appearance")
async def set_appearance(body: AppearanceBody) -> dict:
    """Persist theme and/or font size. Each field is optional so the UI can save just
    the one that changed. Values are stored verbatim; the client validates on read."""
    if body.theme is not None:
        await accounts_svc.set_setting(_APPEARANCE_THEME_KEY, body.theme)
    if body.fontsize is not None:
        await accounts_svc.set_setting(_APPEARANCE_FONTSIZE_KEY, body.fontsize)
    return {"ok": True}


@router.get("/api/signal-rules")
async def get_signal_rules(account_hash: str | None = None) -> dict:
    """User-defined extra signal rules. Defaults to the selected account; pass
    ?account_hash= to read another's (multi-account compare view)."""
    return {"rules": await ledger_svc.get_signal_rules(account_hash or await _selected())}


class SignalRulesBody(BaseModel):
    rules: list
    account_hash: str | None = None   # which account to write (default: selected)


@router.put("/api/signal-rules")
async def set_signal_rules(body: SignalRulesBody) -> dict:
    """Replace the extra signal rules for an account (default: selected)."""
    return await ledger_svc.set_signal_rules(body.account_hash or await _selected(), body.rules)


@router.get("/api/symbol-rules")
async def get_symbol_rules() -> dict:
    """Per-ticker overrides of the global strategy (sell target / dip depth)."""
    return {"rules": await config_store.get_symbol_overrides(await _selected())}


class SymbolRuleBody(BaseModel):
    symbol: str
    sell_mode: str | None = None    # "dollar_gain" | "pct_above"
    sell_value: float | None = None  # $ or FRACTION (0.05 = 5%)
    dip_scale: float | None = None   # 0.1–3.0; 1.0/None = global depth
    clear: bool = False


@router.post("/api/symbol-rules")
async def set_symbol_rule(body: SymbolRuleBody) -> dict:
    """Set (or clear) one ticker's rule override. Signals, buy triggers, sell targets,
    the detail ladder and projections all follow it immediately."""
    ov = None if body.clear else {"sell_mode": body.sell_mode, "sell_value": body.sell_value,
                                  "dip_scale": body.dip_scale}
    res = await config_store.set_symbol_override(await _selected(), body.symbol, ov)
    from .. import dashboard as dashboard_svc
    dashboard_svc.invalidate_dashboard_cache()
    return res


@router.get("/api/etf-links")
async def get_etf_links() -> dict:
    """Manual ETF→underlying overrides for the selected account: {ETF: UNDERLYING}."""
    return {"links": await ledger_svc.get_etf_links(await _selected())}


class EtfLinkBody(BaseModel):
    etf: str
    underlying: str | None = None


@router.post("/api/etf-link")
async def set_etf_link(body: EtfLinkBody) -> dict:
    """Set (blank underlying clears) one ETF→underlying grouping override."""
    return await ledger_svc.set_etf_link(await _selected(), body.etf, body.underlying)
