"""Strategy validator — clean config is silent; broken configs surface the right warnings."""
from app.strategy import StrategyConfig
from app.strategy.validate import check


def test_default_config_is_clean():
    assert check(StrategyConfig.load().to_mapping()) == []


def _msgs(findings):
    return " || ".join(f["message"] for f in findings)


def test_shallower_deeper_drop_warns():
    cfg = StrategyConfig.load().to_mapping()
    cfg["buy_ladder"]["drops"] = [
        {"up_to_rung": 2, "drop_pct": 0.15},
        {"up_to_rung": 7, "drop_pct": 0.10},  # shallower than rung 2 → warn
    ]
    f = check(cfg)
    assert any(x["level"] == "warn" and "SHALLOWER" in x["message"] for x in f)


def test_deployment_multiplier_below_one_warns():
    cfg = StrategyConfig.load().to_mapping()
    cfg["deployment_scaling"] = {"enabled": True, "tiers": [{"min_deployed_pct": 90, "drop_multiplier": 0.8}]}
    assert any("below 1" in x["message"] for x in check(cfg))


def test_deployment_tier_over_100_is_a_valid_margin_tier():
    # Deployed % = market value ÷ own equity, so >100% means margin — a legitimate tier.
    cfg = StrategyConfig.load().to_mapping()
    cfg["deployment_scaling"] = {"enabled": True, "tiers": [{"min_deployed_pct": 120, "drop_multiplier": 1.6}]}
    assert not any("Deployment tier" in x["message"] for x in check(cfg))


def test_negative_deployment_tier_warns():
    cfg = StrategyConfig.load().to_mapping()
    cfg["deployment_scaling"] = {"enabled": True, "tiers": [{"min_deployed_pct": -5, "drop_multiplier": 1.4}]}
    assert any("negative" in x["message"] for x in check(cfg))


def test_multiplier_below_one_is_clamped_by_the_engine():
    from app.strategy.config import DeploymentScaling
    ds = DeploymentScaling.from_mapping({"enabled": True, "tiers": [{"min_deployed_pct": 90, "drop_multiplier": 0.5}]})
    assert ds.tiers[0].drop_multiplier == 1.0


def test_sell_pct_zero_warns():
    cfg = StrategyConfig.load().to_mapping()
    cfg["sell"] = {"default_mode": "pct_above", "dollar_gain": 50, "pct_above": 0}
    assert any("% above buy" in x["message"] for x in check(cfg))


def test_tolerates_empty_and_partial():
    assert check({}) == []            # nothing to check → no crash, no findings
    assert isinstance(check({"buy_ladder": {"drops": [{}]}}), list)  # missing keys ok
