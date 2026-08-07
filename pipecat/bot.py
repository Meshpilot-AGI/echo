"""
cod-pipecat bot — Pipecat pipeline for COD-confirmation calls over Vobiz.

Replaces the Retell orchestrator for +91 COD calls. Media path:
  Vobiz (8kHz mulaw) <-> VobizFrameSerializer <-> Pipecat pipeline
    ElevenLabs Scribe v2 Realtime STT -> Claude Haiku 4.5 (Bedrock via gateway)
    -> ElevenLabs TTS (Monika Sogam)

Slice 2: the LLM has the 4 terminal tools (confirm_order / cancel_order /
request_human_agent / request_callback). When it calls one, we POST the flat
body to cod-confirm's existing tool webhook (/webhook/livekit/tool/{name} on
:3104), which tags the Shopify order AND marks the ScheduledCall row terminal
via markScheduledCallOutcome — so the scheduler's stuck-sweep stops re-dialing
a customer who already decided. The call then ends gracefully.
"""
import os
import asyncio
import aiohttp
from loguru import logger

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import TTSSpeakFrame, EndTaskFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.turns.user_mute.always_user_mute_strategy import AlwaysUserMuteStrategy
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService, CommitStrategy
from pipecat.transcriptions.language import Language
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transports.base_transport import BaseTransport

# LLM = Bedrock (Claude Haiku 4.5) through the Vercel AI Gateway.
LLM_MODEL = os.getenv("PIPECAT_LLM_MODEL", "anthropic/claude-haiku-4.5")
LLM_BASE = (os.getenv("OPENAI_API_BASE_VOICE") or os.getenv("OPENAI_BASE_URL")
            or "https://ai-gateway.vercel.sh/v1")
LLM_KEY = os.getenv("OPENAI_API_KEY_VOICE") or os.getenv("OPENAI_API_KEY") or ""

# STT = ElevenLabs Scribe v2 Realtime (Hinglish, 150ms).
ELEVENLABS_KEY = os.getenv("ELEVENLABS_API_KEY", "")
STT_PROVIDER = os.getenv("PIPECAT_STT_PROVIDER", "sarvam")  # sarvam | elevenlabs
STT_MODEL = os.getenv("PIPECAT_ELEVENLABS_STT_MODEL", "scribe_v2_realtime")
SARVAM_KEY = os.getenv("SARVAM_API_KEY", "")
SARVAM_STT_MODEL = os.getenv("PIPECAT_SARVAM_STT_MODEL", "saarika:v2.5")
STT_LANG = os.getenv("PIPECAT_STT_LANGUAGE", "hi")
# TTS = ElevenLabs "Monika Sogam - Professional Customer Care Agent".
TTS_VOICE = os.getenv("PIPECAT_ELEVENLABS_VOICE_ID", "ZUrEGyu8GFMwnHbvLhv2")
TTS_MODEL = os.getenv("PIPECAT_ELEVENLABS_MODEL", "eleven_multilingual_v2")

# cod-confirm tool webhook (same box). The livekit tool router takes a flat body
# and does Shopify tag + markScheduledCallOutcome.
COD_CONFIRM_BASE = os.getenv("COD_CONFIRM_TOOL_URL", "http://127.0.0.1:3104")
TOOL_SECRET = os.getenv("LIVEKIT_TOOL_SECRET", "")

TERMINAL_TOOLS = ("confirm_order", "cancel_order", "request_human_agent", "request_callback")


def _fmt_amount(v):
    try:
        return str(int(round(float(v))))
    except Exception:
        return str(v or "")


def build_system_prompt(ctx: dict) -> str:
    store = ctx.get("store_name") or "hamari store"
    name = ctx.get("customer_name") or ""
    product = ctx.get("product_name") or "aapka order"
    amount = _fmt_amount(ctx.get("total_amount"))
    city = ctx.get("delivery_city") or ""
    return (
        f"Tum Priya ho, {store} ki polite female COD confirmation agent. "
        "Hinglish (Hindi + thodi English) mein natural, warm, aur short baat karti ho. "
        "Ek baar mein ek hi chhota sentence bolo, ek hi sawaal.\n"
        f"Order: customer={name}; product={product}; amount={amount} rupees; city={city}.\n"
        "ZAROORI: greeting pehle hi bola ja chuka hai. Apna naam ya introduction DOBARA mat do. "
        "Customer ke jawab dete hi seedha kaam pe aao.\n"
        "Flow: (1) chhota sa confirm karo ki order me " + product + " hai aur COD amount " + amount + " rupees hai. "
        "(2) poocho: yeh order confirm karna hai ya cancel? "
        "(3) confirm kare -> confirm_order tool call karo, phir chhota dhanyawaad bolke call close karo. "
        "(4) cancel -> cancel_order. Insaan se baat -> request_human_agent. Baad me call -> request_callback.\n"
        "Order number ya lambe digits mat bolo. Amount simple bolo. "
        "Payment, OTP, ya bank details kabhi mat maango. "
        "Yeh phone call hai: koi emoji, asterisk, star (*), ya markdown formatting mat likho — "
        "sirf plain bola-jaane-wala Hinglish, warna TTS galat bolega."
    )


def _build_tools() -> ToolsSchema:
    return ToolsSchema(standard_tools=[
        FunctionSchema(
            name="confirm_order",
            description="Call this the moment the customer confirms they want the Cash-on-Delivery order delivered.",
            properties={"note": {"type": "string", "description": "Optional short note about the confirmation."}},
            required=[],
        ),
        FunctionSchema(
            name="cancel_order",
            description="Call this when the customer wants to cancel / does not want the order.",
            properties={"reason": {"type": "string", "description": "Customer's reason for cancelling, if given."}},
            required=[],
        ),
        FunctionSchema(
            name="request_human_agent",
            description="Call this when the customer asks to speak to a human agent.",
            properties={"note": {"type": "string", "description": "Optional context."}},
            required=[],
        ),
        FunctionSchema(
            name="request_callback",
            description="Call this when the customer is busy and asks to be called back later.",
            properties={"when": {"type": "string", "description": "Preferred callback time, if given."}},
            required=[],
        ),
    ])


async def run_bot(transport: BaseTransport, handle_sigint: bool, ctx: dict | None = None):
    ctx = ctx or {}

    llm = OpenAILLMService(api_key=LLM_KEY, base_url=LLM_BASE, model=LLM_MODEL)
    # STT provider toggle. Default = Sarvam (Hinglish, no terms gate). ElevenLabs
    # Scribe v2 Realtime is better but returns `unaccepted_terms` and drops the
    # socket mid-call until the account accepts the model terms in the EL
    # dashboard — set PIPECAT_STT_PROVIDER=elevenlabs once that is done.
    if STT_PROVIDER == "elevenlabs":
        stt = ElevenLabsRealtimeSTTService(
            api_key=ELEVENLABS_KEY,
            model=STT_MODEL,
            sample_rate=8000,
            commit_strategy=CommitStrategy.VAD,
            params=ElevenLabsRealtimeSTTService.InputParams(language_code=STT_LANG),
        )
    else:
        stt = SarvamSTTService(api_key=SARVAM_KEY, model=SARVAM_STT_MODEL, sample_rate=8000,
                               params=SarvamSTTService.InputParams(language=Language.HI_IN))
    tts = ElevenLabsTTSService(api_key=ELEVENLABS_KEY, voice_id=TTS_VOICE, model=TTS_MODEL, sample_rate=16000)

    messages = [{"role": "system", "content": build_system_prompt(ctx)}]
    context = LLMContext(messages, tools=_build_tools())
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_mute_strategies=[AlwaysUserMuteStrategy()],
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=16000,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    # ── Terminal tools: POST the cod-confirm tool webhook (Shopify tag +
    #    markScheduledCallOutcome), then wind the call down.
    async def _post_tool(tool_name: str, extra: dict) -> tuple[bool, str]:
        body = {
            "shop": ctx.get("shop", ""),
            "shopify_order_id": ctx.get("entity_ref", ""),
            "order_name": ctx.get("order_number", ""),
        }
        body.update({k: v for k, v in extra.items() if v})
        url = f"{COD_CONFIRM_BASE}/webhook/livekit/tool/{tool_name}"
        if not body["shop"] or not body["shopify_order_id"]:
            logger.warning(f"[tool] {tool_name}: missing shop/order in ctx; skipping webhook")
            return False, "missing shop/order in call context"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, json=body, headers={"X-COD-Tool-Secret": TOOL_SECRET}) as r:
                    txt = await r.text()
                    ok = r.status < 300
                    logger.info(f"[tool] {tool_name} -> {r.status} {txt[:200]}")
                    return ok, txt[:200]
        except Exception as e:
            logger.exception(f"[tool] {tool_name} POST failed: {e}")
            return False, str(e)

    async def _end_call_after_closing():
        # Let the LLM's short closing line generate + play, then end so Vobiz
        # hangs up (serializer auto_hang_up=True). Best-effort.
        try:
            await asyncio.sleep(7)
            await task.queue_frame(EndTaskFrame())
        except Exception as e:
            logger.warning(f"[tool] end-call schedule failed: {e}")

    def _make_handler(tool_name: str):
        async def handler(params):
            args = params.arguments or {}
            extra = {k: args.get(k) for k in ("note", "reason", "when")}
            ok, detail = await _post_tool(tool_name, extra)
            await params.result_callback({"ok": ok, "detail": detail})
            asyncio.create_task(_end_call_after_closing())
        return handler

    for name in TERMINAL_TOOLS:
        llm.register_function(name, _make_handler(name))

    cust = ctx.get("customer_name") or ""
    store = ctx.get("store_name") or "hamari store"
    greeting = ctx.get("opening_line") or (
        f"Namaste{(' ' + cust) if cust else ''} ji, main Priya baat kar rahi hoon {store} se. "
        "Aapke Cash on Delivery order ke confirmation ke liye call kiya hai. "
        "Do minute baat kar sakte hain?"
    )

    @transport.event_handler("on_client_connected")
    async def _on_connected(transport, client):
        logger.info("cod-pipecat: client connected -> speaking greeting")
        await task.queue_frame(TTSSpeakFrame(greeting))

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(transport, client):
        logger.info("cod-pipecat: client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=handle_sigint)
    await runner.run(task)
