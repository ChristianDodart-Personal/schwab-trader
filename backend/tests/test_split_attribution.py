"""A split row Schwab files under a CUSIP must land on the ticker it belongs to (RCAX's
reverse split arrived as 88636Y599 and rescaled nothing). Pure, DB-free."""
from app.fill_store import attribute_cusip_split


def test_unique_quantity_match_attributes_the_split():
    totals = {"RCAX": 729.0, "RCAT": 66.0, "QBTS": 104.0}
    assert attribute_cusip_split("88636Y599", 729.0, totals) == "RCAX"


def test_cash_in_lieu_tolerance_is_one_share():
    assert attribute_cusip_split("88636Y599", 729.0, {"RCAX": 728.4}) == "RCAX"
    assert attribute_cusip_split("88636Y599", 729.0, {"RCAX": 727.0}) is None


def test_ambiguous_or_missing_match_is_never_guessed():
    assert attribute_cusip_split("88636Y599", 729.0, {"RCAX": 729.0, "OTHR": 729.0}) is None
    assert attribute_cusip_split("88636Y599", 729.0, {"RCAT": 66.0}) is None
    assert attribute_cusip_split("88636Y599", 0.0, {"RCAX": 729.0}) is None


def test_cusip_shaped_holdings_are_not_candidates():
    # A phantom lot under another CUSIP must not absorb the split.
    assert attribute_cusip_split("88636Y599", 729.0, {"88636W718": 729.0}) is None
