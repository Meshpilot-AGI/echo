"""
cod-pipecat server — FastAPI answer/ws/start for Vobiz ConversationRelay-style
media streaming into the Pipecat bot (bot.py).

Public (via nginx on media.meshpilot.app -> :3106, prefix /cod-pipecat stripped):
  GET  /health
  POST /start          (X-COD-Tool-Secret) — place an outbound Vobiz call
  ANY  /vobiz/answer   — Vobiz fetches this on answer; returns <Stream> XML
  WS   /vobiz/ws       — bidirectional 8kHz mulaw audio -> Pipecat pipeline

Per-call order context rides `body_data` (JSON) on the answer_url, is re-encoded
base64 as `body` on the ws URL, and is decoded here into the bot's prompt.
"""
import os
import json
import base64
import urllib.parse
from contextlib import asynccontextmanager

import aiohttp
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, Query, HTTPException, Header
from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger

# Shared secrets live in the monorepo root .env; pipecat-specific overrides in
# the local .env (PIPECAT_PUBLIC_URL, model, etc).
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, "..", "..", ".env"), override=False)
load_dotenv(os.path.join(_HERE, ".env"), override=True)

from pipecat.serializers.vobiz import VobizFrameSerializer, parse_vobiz_start  # noqa: E402
from pipecat.transports.websocket.fastapi import (  # noqa: E402
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from bot import run_bot  # noqa: E402

VOBIZ_AUTH_ID = os.getenv("VOBIZ_AUTH_ID", "")
VOBIZ_AUTH_TOKEN = os.getenv("VOBIZ_AUTH_TOKEN", "")
VOBIZ_FROM = os.getenv("VOBIZ_FROM_NUMBER", "")
PUBLIC_URL = os.getenv("PIPECAT_PUBLIC_URL", "").rstrip("/")
TOOL_SECRET = os.getenv("LIVEKIT_TOOL_SECRET", "")
VOBIZ_ENCODING = os.getenv("VOBIZ_ENCODING", "audio/x-mulaw")
VOBIZ_RATE = int(os.getenv("VOBIZ_SAMPLE_RATE", "8000"))
RECORD_ENABLED = os.getenv("PIPECAT_RECORD", "on").lower() != "off"
RECORD_MAXLEN = os.getenv("PIPECAT_RECORD_MAXLEN", "3600")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session = aiohttp.ClientSession()
    logger.info(f"cod-pipecat up. public={PUBLIC_URL} from={VOBIZ_FROM} "
                f"llm={os.getenv('PIPECAT_LLM_MODEL', 'amazon/nova-lite')}")
    yield
    await app.state.session.close()


app = FastAPI(lifespan=lifespan)


def _require_secret(val: str | None):
    if not TOOL_SECRET or val != TOOL_SECRET:
        raise HTTPException(status_code=401, detail="bad or missing X-COD-Tool-Secret")


def _ws_url() -> str:
    wss = PUBLIC_URL.replace("https://", "wss://").replace("http://", "ws://")
    return f"{wss}/vobiz/ws"


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "cod-pipecat",
        "from": VOBIZ_FROM,
        "public": PUBLIC_URL,
        "llm_model": os.getenv("PIPECAT_LLM_MODEL", "amazon/nova-lite"),
        "vobiz_creds": bool(VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN),
    }


@app.api_route("/vobiz/answer", methods=["GET", "POST"])
async def answer(request: Request, body_data: str = Query(None), CallUUID: str = Query(None)):
    ws_url = _ws_url()
    params = []
    if body_data:
        params.append("body=" + urllib.parse.quote(base64.b64encode(body_data.encode()).decode()))
    if CallUUID:
        params.append("call_uuid=" + urllib.parse.quote(CallUUID))
    if params:
        ws_url = ws_url + "?" + "&".join(params)
    content_type = f"{VOBIZ_ENCODING};rate={VOBIZ_RATE}"
    # Record the full call (background session) so it can be pulled to R2. Sits
    # before <Stream>; recordSession keeps recording while media streams. Vobiz
    # POSTs RecordUrl/RecordingID/CallUUID to callbackUrl on completion; the
    # pull-to-R2 reconcile job is the source of truth (this callback just logs).
    record_el = ""
    if RECORD_ENABLED:
        cb = f"{PUBLIC_URL}/vobiz/recording"
        record_el = (
            f'    <Record fileFormat="wav" maxLength="{RECORD_MAXLEN}" recordSession="true" '
            f'callbackUrl="{cb}" callbackMethod="POST"></Record>\n'
        )
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        f"{record_el}"
        f'    <Stream bidirectional="true" audioTrack="inbound" contentType="{content_type}" keepCallAlive="true">\n'
        f"        {ws_url}\n"
        "    </Stream>\n"
        "</Response>"
    )
    logger.info(f"[answer] CallUUID={CallUUID} -> ws_url={ws_url}")
    return HTMLResponse(content=xml, media_type="application/xml")


@app.api_route("/vobiz/recording", methods=["GET", "POST"])
async def vobiz_recording(request: Request):
    # Vobiz posts RecordUrl / RecordingID / CallUUID here when a call recording
    # completes. Actual R2 mirroring is done by the cod-confirm reconcile job
    # (pull-vobiz-recordings) so this is just an observability log + 200 ack.
    try:
        form = dict(await request.form())
    except Exception:
        form = dict(request.query_params)
    logger.info(f"[recording] call={form.get('CallUUID')} id={form.get('RecordingID')} "
                f"url={str(form.get('RecordUrl'))[:70]}")
    return JSONResponse({"ok": True})


@app.websocket("/vobiz/ws")
async def vobiz_ws(websocket: WebSocket, body: str = Query(None), call_uuid: str = Query(None)):
    await websocket.accept()
    ctx = {}
    if body:
        try:
            ctx = json.loads(base64.b64decode(urllib.parse.unquote(body)).decode())
        except Exception as e:
            logger.warning(f"[ws] could not decode body: {e}")
    logger.info(f"[ws] connected call_uuid={call_uuid} ctx_keys={list(ctx.keys())}")

    parsed = await parse_vobiz_start(websocket)
    logger.info(f"[ws] vobiz start call_id={parsed['call_id']} stream_id={parsed['stream_id']} "
                f"fmt=({parsed['encoding']},{parsed['sample_rate']})")

    serializer = VobizFrameSerializer(
        stream_id=parsed["stream_id"],
        call_id=parsed["call_id"],
        auth_id=VOBIZ_AUTH_ID,
        auth_token=VOBIZ_AUTH_TOKEN,
        params=VobizFrameSerializer.InputParams(
            vobiz_sample_rate=parsed["sample_rate"] or VOBIZ_RATE,
            encoding=parsed["encoding"] or VOBIZ_ENCODING,
            sample_rate=None,
            auto_hang_up=True,
        ),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,  # required for telephony
            serializer=serializer,
        ),
    )
    try:
        await run_bot(transport, handle_sigint=False, ctx=ctx)
    except Exception as e:
        logger.exception(f"[ws] bot crashed: {e}")


async def _make_vobiz_call(session, to_number, from_number, answer_url):
    url = f"https://api.vobiz.ai/api/v1/Account/{VOBIZ_AUTH_ID}/Call/"
    headers = {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN,
        "Content-Type": "application/json",
    }
    payload = {"to": to_number, "from": from_number,
               "answer_url": answer_url, "answer_method": "POST"}
    async with session.post(url, headers=headers, json=payload) as r:
        txt = await r.text()
        logger.info(f"[vobiz] POST /Call status={r.status} resp={txt[:300]}")
        if r.status >= 300:
            raise HTTPException(status_code=502, detail=f"vobiz {r.status}: {txt[:200]}")
        try:
            return json.loads(txt)
        except Exception:
            return {"raw": txt}


@app.post("/start")
async def start(request: Request, x_cod_tool_secret: str = Header(None)):
    _require_secret(x_cod_tool_secret)
    data = await request.json()
    phone = str(data.get("phone_number") or data.get("phone") or "")
    if not phone:
        raise HTTPException(status_code=400, detail="phone_number required (E.164)")
    ctx = data.get("body") or data.get("context") or {}
    from_number = data.get("from_number") or VOBIZ_FROM
    if not from_number:
        raise HTTPException(status_code=400, detail="from_number/VOBIZ_FROM_NUMBER not set")
    answer_url = f"{PUBLIC_URL}/vobiz/answer"
    if ctx:
        answer_url += "?body_data=" + urllib.parse.quote(json.dumps(ctx))
    res = await _make_vobiz_call(request.app.state.session, phone, from_number, answer_url)
    call_uuid = res.get("request_uuid") or res.get("call_uuid") or res.get("api_id") or "unknown"
    return JSONResponse({"ok": True, "call_uuid": call_uuid, "phone": phone, "vobiz": res})
