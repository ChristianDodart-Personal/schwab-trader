"""CUSIP-vs-ticker identity: the guard against Schwab reporting a holding under its
CUSIP (RCAX arrived as 88636W718 on 2026-09-08), which made reconcile drop the real
lots and backfill a phantom. DB-free."""
import pytest

from app import symbols
from app.positions_sync import _fetch_positions_sync


class _Resp:
    def __init__(self, body, status=200):
        self._b, self.status_code = body, status
    def json(self):
        return self._b


class _Client:
    """Fake schwab client: positions payload + a CUSIP->instrument table, counting lookups."""
    def __init__(self, positions, cusips=None, cusip_status=200):
        self._positions, self._cusips, self._status = positions, cusips or {}, cusip_status
        self.lookups = 0
        class _F:  # mimics client.Account.Fields.POSITIONS
            POSITIONS = "positions"
        class _A:
            Fields = _F
        self.Account = _A
    def get_account(self, _hash, fields=None):
        return _Resp({"securitiesAccount": {"positions": self._positions}})
    def get_instrument_by_cusip(self, cusip):
        self.lookups += 1
        body = self._cusips.get(cusip)
        return _Resp(body if body is not None else {"instruments": []}, self._status)


@pytest.fixture(autouse=True)
def _clear_cache():
    symbols._cache.clear()
    yield
    symbols._cache.clear()


# ---------- is_cusip_like ----------

def test_real_cusip_passes_check_digit():
    assert symbols.is_cusip_like("88636W718")       # RCAX's CUSIP, the live incident
    assert symbols.is_cusip_like("037833100")       # AAPL
    assert symbols.is_cusip_like("88636w718")       # case-insensitive


def test_tickers_and_junk_are_not_cusips():
    for s in ("RCAX", "QBTX", "AAPL", "BRK/B", "88636W71", "88636W7188", "", None):
        assert not symbols.is_cusip_like(s), s


def test_bad_check_digit_is_rejected():
    assert not symbols.is_cusip_like("88636W719")   # last digit off by one


# ---------- _extract_symbol: all three response shapes ----------

@pytest.mark.parametrize("payload", [
    {"instruments": [{"cusip": "88636W718", "symbol": "RCAX"}]},
    {"cusip": "88636W718", "symbol": "RCAX"},
    [{"cusip": "88636W718", "symbol": "RCAX"}],
])
def test_extract_symbol_shapes(payload):
    assert symbols._extract_symbol(payload) == "RCAX"


def test_extract_symbol_refuses_cusip_shaped_answer_and_empties():
    assert symbols._extract_symbol({"instruments": [{"symbol": "88636W718"}]}) is None
    assert symbols._extract_symbol({"instruments": []}) is None
    assert symbols._extract_symbol(None) is None


# ---------- resolve_symbol ----------

def test_plain_ticker_returns_without_a_lookup():
    c = _Client([], cusips={})
    assert symbols.resolve_symbol(c, {"symbol": "RCAX", "cusip": "88636W718"}) == "RCAX"
    assert c.lookups == 0


def test_cusip_in_symbol_field_is_resolved_and_cached():
    c = _Client([], cusips={"88636W718": {"instruments": [{"symbol": "RCAX", "cusip": "88636W718"}]}})
    instr = {"symbol": "88636W718", "cusip": "88636W718", "assetType": "ETF"}
    assert symbols.resolve_symbol(c, instr) == "RCAX"
    assert symbols.resolve_symbol(c, instr) == "RCAX"
    assert c.lookups == 1                            # second call served from cache


def test_unresolvable_cusip_returns_none_and_caches_the_miss():
    c = _Client([], cusips={})
    instr = {"symbol": "88636W718", "cusip": "88636W718"}
    assert symbols.resolve_symbol(c, instr) is None
    assert symbols.resolve_symbol(c, instr) is None
    assert c.lookups == 1


def test_lookup_exception_is_swallowed_as_unresolved():
    class _Boom(_Client):
        def get_instrument_by_cusip(self, cusip):
            raise RuntimeError("network")
    assert symbols.resolve_symbol(_Boom([]), {"symbol": "88636W718"}) is None


# ---------- _fetch_positions_sync: the reconcile input ----------

def _pos(symbol, qty, avg=3.44, cusip=None, asset="ETF"):
    return {"instrument": {"symbol": symbol, "cusip": cusip or symbol, "assetType": asset},
            "longQuantity": qty, "shortQuantity": 0, "averagePrice": avg}


def test_positions_under_cusip_come_back_under_the_ticker():
    # The exact incident: Schwab lists 729 RCAX shares as 88636W718. Resolved, the
    # snapshot keys the holding by RCAX, so reconcile matches the fill-built lots.
    c = _Client([_pos("RCAT", 46, 10.72), _pos("88636W718", 729, 3.44)],
                cusips={"88636W718": {"instruments": [{"symbol": "RCAX"}]}})
    rows = _fetch_positions_sync(c, "abcd1234")
    assert sorted(rows) == [("RCAT", 46.0, 10.72), ("RCAX", 729.0, 3.44)]


def test_unidentified_holding_makes_the_snapshot_unavailable():
    # If the CUSIP can't be mapped, the snapshot must NOT be trusted as "you hold exactly
    # these symbols": returning None makes rebuild skip reconcile, so the real ticker's
    # lots are neither dropped nor shadowed by a phantom under the CUSIP.
    c = _Client([_pos("RCAT", 46, 10.72), _pos("88636W718", 729, 3.44)], cusips={})
    assert _fetch_positions_sync(c, "abcd1234") is None


def test_zero_quantity_unidentified_row_does_not_block_the_snapshot():
    c = _Client([_pos("RCAT", 46, 10.72), _pos("88636W718", 0, 3.44)], cusips={})
    assert _fetch_positions_sync(c, "abcd1234") == [("RCAT", 46.0, 10.72)]
