from __future__ import annotations

import asyncio
import html
import json
import random
import re
import time
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

USER_AGENT = "Mozilla/5.0 (crypto-dashboard lab3)"
HTTP_TIMEOUT = 10.0

WS_STALE_TIMEOUT = 30.0
RECONNECT_BASE = 1.0
RECONNECT_MAX = 30.0

HTTP_RETRY_BASE = 5.0


@dataclass(frozen=True)
class Coin:
    symbol: str
    name: str
    gecko_id: str
    news_tag: str
    quote: str = "USDT"

    @property
    def binance(self) -> str:
        return f"{self.symbol}{self.quote}"

    @property
    def coinbase(self) -> str:
        return f"{self.symbol}-USD"


COINS: list[Coin] = [
    Coin("BTC", "Bitcoin", "bitcoin", "bitcoin"),
    Coin("ETH", "Ethereum", "ethereum", "ethereum"),
    Coin("SOL", "Solana", "solana", "solana"),
    Coin("BNB", "BNB", "binancecoin", "bnb"),
    Coin("XRP", "XRP", "ripple", "xrp"),
    Coin("DOGE", "Dogecoin", "dogecoin", "dogecoin"),
    Coin("ADA", "Cardano", "cardano", "cardano"),
    Coin("TON", "Toncoin", "the-open-network", "ton"),
    Coin("TRX", "TRON", "tron", "tron"),
    Coin("LTC", "Litecoin", "litecoin", "litecoin"),
    Coin("DOT", "Polkadot", "polkadot", "polkadot"),
    Coin("LINK", "Chainlink", "chainlink", "chainlink"),
    Coin("AVAX", "Avalanche", "avalanche-2", "avalanche"),
]


def find_coin(symbol: str) -> Coin | None:
    symbol = symbol.upper()
    return next((c for c in COINS if c.symbol == symbol), None)


@dataclass(slots=True)
class Ticker:
    last: float
    change: float
    change_pct: float
    high: float
    low: float
    volume: float
    quote_volume: float
    bid: float
    ask: float
    trades: int


@dataclass(slots=True)
class Trade:
    price: float
    qty: float
    time: float
    is_sell: bool


@dataclass(slots=True)
class Candle:
    open_time: float
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(slots=True)
class OrderBook:
    bids: list[tuple[float, float]]
    asks: list[tuple[float, float]]


@dataclass(slots=True)
class CoinbaseTicker:
    price: float
    open_24h: float
    bid: float
    ask: float


@dataclass(slots=True)
class CoinInfo:
    name: str
    symbol: str
    rank: int | None
    price: float | None
    market_cap: float | None
    fdv: float | None
    volume: float | None
    circulating: float | None
    total_supply: float | None
    max_supply: float | None
    ath: float | None
    ath_change_pct: float | None
    ath_date: str | None
    atl: float | None
    change_7d: float | None
    change_30d: float | None
    change_1y: float | None
    genesis: str | None
    algorithm: str | None
    categories: list[str]
    homepage: str | None
    description: str


@dataclass(slots=True)
class FearGreed:
    value: int
    label: str
    yesterday: int | None
    next_update_s: int | None


@dataclass(slots=True)
class GlobalMarket:
    market_cap: float
    market_cap_change_24h: float
    volume_24h: float
    btc_dominance: float
    cryptocurrencies: int
    market_cap_ath: float | None


@dataclass(slots=True)
class NewsItem:
    title: str
    link: str
    published: datetime | None
    author: str | None


@dataclass(slots=True)
class Event:
    source: str
    state: str
    data: Any = None
    channel: str | None = None
    latency: float | None = None
    error: str | None = None
    retry_in: float | None = None
    detail: str | None = None


@dataclass(frozen=True)
class SourceInfo:
    key: str
    title: str
    kind: str
    provides: str


SOURCES: dict[str, SourceInfo] = {
    s.key: s
    for s in [
        SourceInfo("binance_ws", "Binance", "WS", "цена, сделки, свечи, стакан"),
        SourceInfo("coinbase_ws", "Coinbase", "WS", "цена на 2-й бирже"),
        SourceInfo("klines", "Binance REST", "HTTP", "история свечей"),
        SourceInfo("coingecko", "CoinGecko", "HTTP", "информация о монете"),
        SourceInfo("global", "CoinPaprika", "HTTP", "глобальный рынок"),
        SourceInfo("fng", "alternative.me", "HTTP", "индекс страха/жадности"),
        SourceInfo("news", "Cointelegraph", "HTTP", "новости (RSS)"),
    ]
}


class SourceUnavailable(Exception):
    pass


class InjectedFault(Exception):
    pass


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        hint = {429: " — лимит запросов", 404: " — не найдено"}.get(code, "")
        return f"HTTP {code}{hint}"
    if isinstance(exc, httpx.TimeoutException):
        return "таймаут HTTP"
    if isinstance(exc, httpx.ConnectError):
        return "нет соединения"
    if isinstance(exc, InvalidStatus):
        return f"WS handshake: HTTP {exc.response.status_code}"
    if isinstance(exc, ConnectionClosed):
        return "соединение разорвано" if exc.rcvd is None else f"закрыто сервером ({exc.rcvd.code})"
    if isinstance(exc, (OSError, httpx.TransportError)):
        return f"сеть: {exc}" if str(exc) else f"сеть: {type(exc).__name__}"
    text = str(exc) or type(exc).__name__
    return text if len(text) <= 80 else text[:77] + "..."


class Controls:
    def __init__(self) -> None:
        self._sockets: set[ClientConnection] = set()
        self._wakers: dict[str, asyncio.Event] = {}
        self._faults: set[str] = set()

    async def sleep(self, key: str, delay: float) -> None:
        waker = self._wakers[key] = asyncio.Event()
        try:
            await asyncio.wait_for(waker.wait(), delay)
        except TimeoutError:
            pass
        finally:
            self._wakers.pop(key, None)

    def refresh(self, keys: list[str] | None = None) -> None:
        for key, waker in self._wakers.items():
            if keys is None or key in keys:
                waker.set()

    def drop_websockets(self) -> int:
        sockets = list(self._sockets)
        for ws in sockets:
            ws.transport.abort()
        return len(sockets)

    def fail_next(self, keys: list[str]) -> None:
        self._faults.update(keys)

    def take_fault(self, key: str) -> bool:
        if key in self._faults:
            self._faults.discard(key)
            return True
        return False


async def _ws_session(
    key: str,
    url: str,
    parse: Callable[[dict], Iterator[Event]],
    controls: Controls,
    subscribe: dict | None = None,
) -> AsyncIterator[Event]:
    failures = 0
    while True:
        yield Event(key, "connecting", detail=f"попытка {failures + 1}")
        connected = False
        try:
            async with connect(
                url,
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=2,
                user_agent_header=USER_AGENT,
            ) as ws:
                controls._sockets.add(ws)
                try:
                    if subscribe is not None:
                        await ws.send(json.dumps(subscribe))
                    connected = True
                    failures = 0
                    yield Event(key, "connected", detail=url.split("?")[0])
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), WS_STALE_TIMEOUT)
                        for event in parse(json.loads(raw)):
                            yield event
                finally:
                    controls._sockets.discard(ws)
        except asyncio.CancelledError:
            raise
        except SourceUnavailable as exc:
            yield Event(key, "unavailable", error=str(exc))
            return
        except TimeoutError:
            error = f"нет данных {WS_STALE_TIMEOUT:.0f} с" if connected else "таймаут подключения"
        except Exception as exc:
            error = describe_error(exc)

        failures += 1
        delay = min(RECONNECT_MAX, RECONNECT_BASE * 2 ** (failures - 1)) + random.uniform(0, 0.5)
        yield Event(key, "disconnected", error=error, retry_in=delay)
        await asyncio.sleep(delay)


def binance_stream(coin: Coin, controls: Controls) -> AsyncIterator[Event]:
    s = coin.binance.lower()
    streams = f"{s}@ticker/{s}@aggTrade/{s}@kline_1m/{s}@depth10@1000ms"
    url = f"wss://stream.binance.com:9443/stream?streams={streams}"
    key = "binance_ws"

    def parse(msg: dict) -> Iterator[Event]:
        stream: str = msg.get("stream", "")
        d = msg.get("data") or {}
        if stream.endswith("@ticker"):
            ticker = Ticker(
                last=float(d["c"]),
                change=float(d["p"]),
                change_pct=float(d["P"]),
                high=float(d["h"]),
                low=float(d["l"]),
                volume=float(d["v"]),
                quote_volume=float(d["q"]),
                bid=float(d["b"]),
                ask=float(d["a"]),
                trades=int(d["n"]),
            )
            yield Event(key, "data", ticker, channel="ticker")
        elif stream.endswith("@aggTrade"):
            trade = Trade(float(d["p"]), float(d["q"]), d["T"] / 1000, bool(d["m"]))
            yield Event(key, "data", trade, channel="trade")
        elif "@kline" in stream:
            k = d["k"]
            candle = Candle(
                k["t"] / 1000, float(k["o"]), float(k["h"]), float(k["l"]), float(k["c"]), float(k["v"])
            )
            yield Event(key, "data", candle, channel="kline")
        elif "@depth" in stream:
            book = OrderBook(
                bids=[(float(p), float(q)) for p, q in d["bids"]],
                asks=[(float(p), float(q)) for p, q in d["asks"]],
            )
            yield Event(key, "data", book, channel="depth")

    return _ws_session(key, url, parse, controls)


def coinbase_stream(coin: Coin, controls: Controls) -> AsyncIterator[Event]:
    key = "coinbase_ws"
    subscribe = {
        "type": "subscribe",
        "product_ids": [coin.coinbase],
        "channels": ["ticker", "heartbeat"],
    }

    def parse(msg: dict) -> Iterator[Event]:
        kind = msg.get("type")
        if kind == "ticker":
            ticker = CoinbaseTicker(
                price=float(msg["price"]),
                open_24h=float(msg["open_24h"]),
                bid=float(msg.get("best_bid") or 0),
                ask=float(msg.get("best_ask") or 0),
            )
            yield Event(key, "data", ticker, channel="ticker")
        elif kind == "error":
            reason = msg.get("reason") or msg.get("message") or "ошибка подписки"
            if "not a valid product" in reason or "Failed to subscribe" in (msg.get("message") or ""):
                raise SourceUnavailable(f"нет пары {coin.coinbase}")
            raise RuntimeError(reason)

    return _ws_session(key, "wss://ws-feed.exchange.coinbase.com", parse, controls, subscribe)


Fetch = Callable[[httpx.AsyncClient, Coin], Awaitable[Any]]


@dataclass(frozen=True)
class HttpSource:
    key: str
    interval: float
    fetch: Fetch = field(repr=False)


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


async def fetch_klines(client: httpx.AsyncClient, coin: Coin) -> list[Candle]:
    resp = await client.get(
        "https://api.binance.com/api/v3/klines",
        params={"symbol": coin.binance, "interval": "1m", "limit": 240},
    )
    resp.raise_for_status()
    return [
        Candle(k[0] / 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
        for k in resp.json()
    ]


_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    text = _TAG_RE.sub("", text or "")
    return re.sub(r"\s+\n", "\n", html.unescape(text)).strip()


async def fetch_coin_info(client: httpx.AsyncClient, coin: Coin) -> CoinInfo:
    resp = await client.get(
        f"https://api.coingecko.com/api/v3/coins/{coin.gecko_id}",
        params={
            "localization": "false",
            "tickers": "false",
            "market_data": "true",
            "community_data": "false",
            "developer_data": "false",
            "sparkline": "false",
        },
    )
    resp.raise_for_status()
    j = resp.json()
    md = j.get("market_data") or {}

    def usd(name: str) -> Any:
        return (md.get(name) or {}).get("usd")

    homepage = next((u for u in (j.get("links") or {}).get("homepage", []) if u), None)
    return CoinInfo(
        name=j.get("name", coin.name),
        symbol=(j.get("symbol") or coin.symbol).upper(),
        rank=j.get("market_cap_rank"),
        price=_num(usd("current_price")),
        market_cap=_num(usd("market_cap")),
        fdv=_num(usd("fully_diluted_valuation")),
        volume=_num(usd("total_volume")),
        circulating=_num(md.get("circulating_supply")),
        total_supply=_num(md.get("total_supply")),
        max_supply=_num(md.get("max_supply")),
        ath=_num(usd("ath")),
        ath_change_pct=_num(usd("ath_change_percentage")),
        ath_date=usd("ath_date"),
        atl=_num(usd("atl")),
        change_7d=_num(md.get("price_change_percentage_7d")),
        change_30d=_num(md.get("price_change_percentage_30d")),
        change_1y=_num(md.get("price_change_percentage_1y")),
        genesis=j.get("genesis_date"),
        algorithm=j.get("hashing_algorithm"),
        categories=[c for c in j.get("categories") or [] if c],
        homepage=homepage,
        description=_strip_html((j.get("description") or {}).get("en", "")),
    )


async def fetch_fear_greed(client: httpx.AsyncClient, coin: Coin) -> FearGreed:
    resp = await client.get("https://api.alternative.me/fng/", params={"limit": 2})
    resp.raise_for_status()
    data = resp.json()["data"]
    today = data[0]
    return FearGreed(
        value=int(today["value"]),
        label=today["value_classification"],
        yesterday=int(data[1]["value"]) if len(data) > 1 else None,
        next_update_s=int(today["time_until_update"]) if today.get("time_until_update") else None,
    )


async def fetch_global(client: httpx.AsyncClient, coin: Coin) -> GlobalMarket:
    resp = await client.get("https://api.coinpaprika.com/v1/global")
    resp.raise_for_status()
    j = resp.json()
    return GlobalMarket(
        market_cap=float(j["market_cap_usd"]),
        market_cap_change_24h=float(j["market_cap_change_24h"]),
        volume_24h=float(j["volume_24h_usd"]),
        btc_dominance=float(j["bitcoin_dominance_percentage"]),
        cryptocurrencies=int(j["cryptocurrencies_number"]),
        market_cap_ath=_num(j.get("market_cap_ath_value")),
    )


async def fetch_news(client: httpx.AsyncClient, coin: Coin) -> list[NewsItem]:
    resp = await client.get(f"https://cointelegraph.com/rss/tag/{coin.news_tag}")
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items: list[NewsItem] = []
    for item in root.iter("item"):
        published = None
        if pub := item.findtext("pubDate"):
            try:
                published = parsedate_to_datetime(pub)
            except (TypeError, ValueError):
                pass
        items.append(
            NewsItem(
                title=html.unescape((item.findtext("title") or "").strip()),
                link=(item.findtext("link") or "").strip(),
                published=published,
                author=item.findtext("{http://purl.org/dc/elements/1.1/}creator"),
            )
        )
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    items.sort(key=lambda n: n.published or epoch, reverse=True)
    return items[:20]


HTTP_SOURCES: list[HttpSource] = [
    HttpSource("klines", 120, fetch_klines),
    HttpSource("coingecko", 60, fetch_coin_info),
    HttpSource("global", 60, fetch_global),
    HttpSource("fng", 300, fetch_fear_greed),
    HttpSource("news", 120, fetch_news),
]


async def poll_http(
    source: HttpSource, client: httpx.AsyncClient, coin: Coin, controls: Controls
) -> AsyncIterator[Event]:
    failures = 0
    while True:
        yield Event(source.key, "loading")
        started = time.perf_counter()
        try:
            if controls.take_fault(source.key):
                await asyncio.sleep(0.3)
                raise InjectedFault("искусственный сбой")
            data = await source.fetch(client, coin)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failures += 1
            delay = min(source.interval, HTTP_RETRY_BASE * 2 ** (failures - 1))
            if isinstance(exc, httpx.HTTPStatusError):
                retry_after = exc.response.headers.get("Retry-After", "")
                if retry_after.isdigit():
                    delay = max(delay, min(float(retry_after), 300))
            yield Event(
                source.key,
                "error",
                error=describe_error(exc),
                latency=time.perf_counter() - started,
                retry_in=delay,
            )
        else:
            failures = 0
            delay = source.interval
            yield Event(source.key, "data", data, latency=time.perf_counter() - started, retry_in=delay)
        await controls.sleep(source.key, delay)


def make_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=HTTP_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json, application/xml;q=0.9, */*;q=0.8"},
        limits=httpx.Limits(max_connections=20),
    )
