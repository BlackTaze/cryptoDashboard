from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from aiohttp import WSMsgType, web

import sources as src

STATIC = Path(__file__).with_name("static")
HTTP_CLIENT = web.AppKey("http_client", httpx.AsyncClient)

log = logging.getLogger("dashboard")


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"не сериализуется: {type(value).__name__}")


def dump(message: dict) -> str:
    return json.dumps(message, default=_json_default, ensure_ascii=False)


def event_message(event: src.Event) -> str:
    return dump({"type": "event", **dataclasses.asdict(event)})


def notice(text: str) -> str:
    return dump({"type": "notice", "text": text})


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC / "index.html")


async def meta(request: web.Request) -> web.Response:
    return web.json_response(
        {
            "coins": [
                {"symbol": c.symbol, "name": c.name, "quote": c.quote, "coinbase": c.coinbase}
                for c in src.COINS
            ],
            "sources": [dataclasses.asdict(s) for s in src.SOURCES.values()],
            "http_intervals": {s.key: s.interval for s in src.HTTP_SOURCES},
        }
    )


async def dashboard_socket(request: web.Request) -> web.WebSocketResponse:
    coin = src.find_coin(request.query.get("coin", ""))
    if coin is None:
        raise web.HTTPNotFound(text="неизвестная монета")

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    peer = request.remote
    log.info("сессия %s открыта (%s)", coin.symbol, peer)

    controls = src.Controls()
    outbox: asyncio.Queue[str] = asyncio.Queue()
    client = request.app[HTTP_CLIENT]

    async def pump(feed) -> None:
        had_data = False
        async for event in feed:
            outbox.put_nowait(event_message(event))
            if event.source == "binance_ws":
                if event.state == "connected" and had_data:
                    controls.refresh(["klines"])
                had_data = had_data or event.state == "data"

    async def sender() -> None:
        while True:
            await ws.send_str(await outbox.get())

    feeds = [
        src.binance_stream(coin, controls),
        src.coinbase_stream(coin, controls),
        *(src.poll_http(s, client, coin, controls) for s in src.HTTP_SOURCES),
    ]
    tasks = [asyncio.create_task(pump(feed)) for feed in feeds]
    tasks.append(asyncio.create_task(sender()))

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                command = json.loads(msg.data).get("cmd")
            except (ValueError, AttributeError):
                continue
            if command == "refresh":
                controls.refresh()
                outbox.put_nowait(notice("Запрошено внеочередное обновление HTTP-источников"))
            elif command == "drop_ws":
                n = controls.drop_websockets()
                outbox.put_nowait(notice(f"Демонстрация: разорвано WebSocket-соединений с биржами: {n}"))
            elif command == "fail_http":
                keys = [s.key for s in src.HTTP_SOURCES]
                controls.fail_next(keys)
                controls.refresh(keys)
                outbox.put_nowait(notice("Демонстрация: следующий запрос каждого HTTP-источника завершится ошибкой"))
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("сессия %s закрыта (%s)", coin.symbol, peer)
    return ws


async def http_client_ctx(app: web.Application):
    app[HTTP_CLIENT] = src.make_http_client()
    yield
    await app[HTTP_CLIENT].aclose()


async def revalidate_static(request: web.Request, response: web.StreamResponse) -> None:
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"


def make_app() -> web.Application:
    app = web.Application()
    app.cleanup_ctx.append(http_client_ctx)
    app.on_response_prepare.append(revalidate_static)
    app.router.add_get("/", index)
    app.router.add_get("/api/meta", meta)
    app.router.add_get("/ws", dashboard_socket)
    app.router.add_static("/static", STATIC)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Крипто-дашборд (веб-версия)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    print(f"Crypto Dashboard: откройте http://{args.host}:{args.port} (Ctrl+C — остановить)")
    web.run_app(make_app(), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
