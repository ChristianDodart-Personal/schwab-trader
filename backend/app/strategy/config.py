"""Typed loader for the strategy config (default_strategy.yaml).

Strategy numbers live in YAML; this module just parses them into typed objects
so the rest of the app gets autocomplete and validation. Swap the YAML, restart,
and the new rules take effect — no other code changes.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

_DEFAULT_PATH = Path(__file__).with_name("default_strategy.yaml")


@dataclass(frozen=True)
class SizingTier:
    up_to_rungs: int
    dollars: float


@dataclass(frozen=True)
class LadderDrop:
    up_to_rung: int
    drop_pct: float


@dataclass(frozen=True)
class SellConfig:
    default_mode: str          # "dollar_gain" | "pct_above"
    dollar_gain: float
    pct_above: float


@dataclass(frozen=True)
class DeploymentTier:
    min_deployed_pct: float    # apply when the account's deployed% ≥ this
    drop_multiplier: float     # scale the base ladder drop (>1 = require deeper dips)


@dataclass(frozen=True)
class DeploymentScaling:
    """Optional: make the ladder's required drop % adapt to how deployed the account
    is (the sheet's Tier 1/2/3 behavior). Heavily deployed ⇒ larger multiplier ⇒ wait
    for deeper dips before adding, conserving buying power. Disabled = fixed ladder."""
    enabled: bool
    tiers: tuple[DeploymentTier, ...]   # sorted DESCENDING by min_deployed_pct

    @classmethod
    def from_mapping(cls, data: dict | None) -> "DeploymentScaling":
        data = data or {}
        tiers = sorted(
            # Clamped to >= 1.0: scaling only ever demands DEEPER dips when deployed,
            # never shallower ones (the Rules tab promises this; the engine enforces it).
            (DeploymentTier(min_deployed_pct=float(t["min_deployed_pct"]),
                            drop_multiplier=max(1.0, float(t["drop_multiplier"])))
             for t in data.get("tiers", [])),
            key=lambda t: t.min_deployed_pct, reverse=True,
        )
        return cls(enabled=bool(data.get("enabled", False)), tiers=tuple(tiers))


@dataclass(frozen=True)
class StrategyConfig:
    sizing_tiers: tuple[SizingTier, ...]
    max_rungs: int
    ladder_drops: tuple[LadderDrop, ...]
    sell: SellConfig
    deployment_scaling: DeploymentScaling
    guardrails: dict

    @classmethod
    def from_mapping(cls, data: dict) -> "StrategyConfig":
        ladder = data["buy_ladder"]
        sell = data["sell"]
        # Tiers MUST be ascending — the engine returns the first tier whose
        # threshold the rung falls under, so normalize order regardless of input.
        tiers = sorted((SizingTier(**t) for t in data["sizing_tiers"]),
                       key=lambda t: t.up_to_rungs)
        drops = sorted((LadderDrop(**d) for d in ladder["drops"]),
                       key=lambda d: d.up_to_rung)
        return cls(
            sizing_tiers=tuple(tiers),
            # Retained for wire/back-compat only — the ladder no longer has a hard cap
            # (buys are unlimited; the projection horizon is a fixed short window). Kept
            # in the schema so older/newer saved configs round-trip; tolerate its absence.
            max_rungs=int(ladder.get("max_rungs", 0) or 0),
            ladder_drops=tuple(drops),
            sell=SellConfig(
                default_mode=sell["default_mode"],
                dollar_gain=float(sell["dollar_gain"]),
                pct_above=float(sell["pct_above"]),
            ),
            deployment_scaling=DeploymentScaling.from_mapping(data.get("deployment_scaling")),
            guardrails=dict(data.get("guardrails") or {}),
        )

    @classmethod
    def load(cls, path: Path | None = None) -> "StrategyConfig":
        return cls.from_mapping(yaml.safe_load((path or _DEFAULT_PATH).read_text()))

    def to_mapping(self) -> dict:
        """YAML/JSON-equivalent structure (round-trips with from_mapping)."""
        return {
            "sizing_tiers": [{"up_to_rungs": t.up_to_rungs, "dollars": t.dollars}
                             for t in self.sizing_tiers],
            "buy_ladder": {
                "max_rungs": self.max_rungs,
                "drops": [{"up_to_rung": d.up_to_rung, "drop_pct": d.drop_pct}
                          for d in self.ladder_drops],
            },
            "sell": {"default_mode": self.sell.default_mode,
                     "dollar_gain": self.sell.dollar_gain,
                     "pct_above": self.sell.pct_above},
            "deployment_scaling": {
                "enabled": self.deployment_scaling.enabled,
                "tiers": [{"min_deployed_pct": t.min_deployed_pct, "drop_multiplier": t.drop_multiplier}
                          for t in self.deployment_scaling.tiers],
            },
            "guardrails": dict(self.guardrails),
        }
