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
import re
import asyncio
import aiohttp
from datetime import datetime, timezone
from loguru import logger

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    TTSSpeakFrame,
    EndTaskFrame,
    TranscriptionFrame,
    LLMContextAssistantTurnFrame,
    BotStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
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
TOOL_SECRET = os.getenv("COD_TOOL_SECRET") or os.getenv("LIVEKIT_TOOL_SECRET", "")

TERMINAL_TOOLS = ("confirm_order", "cancel_order", "request_human_agent", "request_callback")

# ── parity: safety/parity config (from livekit-agent.js) ────────────────────
# Same env var names + defaults as apps/cod_confirm/src/livekit-agent.js so
# both voice paths tune identically. All values are seconds here (bot.py) vs
# milliseconds in the JS source — converted at read time.
MAX_CALL_MS = int(os.getenv("MAX_CALL_MS", "150000"))
NO_INPUT_NUDGE_MS = int(os.getenv("NO_INPUT_NUDGE_MS", "7000"))
NO_INPUT_HANGUP_MS = int(os.getenv("NO_INPUT_HANGUP_MS", "20000"))
MAX_CONFUSION_TURNS = int(os.getenv("MAX_CONFUSION_TURNS", "2"))
CONFUSION_CLOSE_DELAY_S = float(os.getenv("CONFUSION_CLOSE_DELAY_S", "7"))

# Transcript-persistence webhook (Node cod-confirm server, same box). Reuses
# COD_CONFIRM_TOOL_URL's host:port — /webhook/livekit/turn is mounted on the
# same Express app as the /webhook/livekit/tool/* routes used by _post_tool
# below, both gated by the same X-COD-Tool-Secret (requireToolAuth in
# src/lib/tool-auth.js reads COD_TOOL_SECRET || LIVEKIT_TOOL_SECRET).
TURN_WEBHOOK_URL = os.getenv("COD_CONFIRM_TURN_URL") or f"{COD_CONFIRM_BASE}/webhook/livekit/turn"

# parity: voicemail detection patterns (from livekit-agent.js VOICEMAIL_PATTERNS,
# verbatim). Broad partial match anywhere in any of the first 4 user
# transcripts triggers an immediate hangup. Devanagari patterns catch Sarvam/
# hi-IN STT transliterating an English voicemail greeting; the plain patterns
# catch an English greeting transcribed as-is.
VOICEMAIL_PATTERNS = [re.compile(p, flags) for p, flags in [
    (r"व[ोॉ]इस[\s\-]*मे", 0),
    (r"फ[ॉो]रवर्डेड\s+टू", 0),
    (r"न[ॉो]ट\s+अव[ेै]लेबल", 0),
    (r"रिक[ॉो]र्ड\s+य[ोौ]र\s+म[ैे]सेज", 0),
    (r"लीव\s+अ\s+म[ैे]सेज", 0),
    (r"एट\s+द\s+ट[ोौ]न", 0),
    (r"आफ्टर\s+द\s+बीप", 0),
    (r"व्हेन\s+य[ोौ]\s+ह[ैै]व\s+फिनिश्ड", 0),
    (r"इस\s+समय\s+उपलब्ध\s+नहीं", 0),
    (r"कृपया\s+संदेश\s+छोड़", 0),
    (r"voicemail|voice\s*mail", re.IGNORECASE),
    (r"answering\s*machine", re.IGNORECASE),
    (r"please\s+(record|leave)\s+(your\s+)?(message|name)", re.IGNORECASE),
    (r"(after|at)\s+the\s+(tone|beep)", re.IGNORECASE),
]]

# parity: anti-loop "confusion" closer regex (from livekit-agent.js
# CONFUSION_RE, verbatim). NOTE: bot.py's system prompt asks the LLM for
# romanized Hinglish, not Devanagari, so the Devanagari half of this pattern
# is unlikely to ever match here — kept verbatim for parity/discoverability;
# see the final report for this caveat.
CONFUSION_RE = re.compile(
    r"समझ नहीं आ|समझ नहीं पा|समझ नहीं|सुनाई नहीं|दोबारा बोल|फिर से बोल|माफ़? कीज|"
    r"didn'?t (catch|hear|understand)|could ?n'?t (catch|hear|understand)|come again|"
    r"could you repeat|say that again",
    re.IGNORECASE,
)


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


class CallGuards:
    """parity: engine-level call-safety state (from livekit-agent.js's per-session
    guards: armInitialSilenceGuard/armSilenceTimer/armMaxCallTimer, the
    VOICEMAIL_PATTERNS check, the anti-loop confusion closer, and postTurn).

    Pipecat has no single "session" object like LiveKit's voice.AgentSession —
    this class is the Pipecat-side equivalent: it owns the timers/counters and
    is driven by a CallSafetyObserver watching frames flow through the
    pipeline (TranscriptionFrame = a final user turn, LLMContextAssistantTurnFrame
    = a completed assistant turn), plus explicit calls from the terminal-tool
    handlers below.
    """

    def __init__(self, ctx: dict):
        self.ctx = ctx
        self.room_name = str(ctx.get("_call_uuid") or ctx.get("_call_id") or "unknown-call")
        self.sip_call_id = ctx.get("_call_id")
        self._task: PipelineTask | None = None

        self._turn_index = 0
        self._terminal_fired = False
        self._voicemail_detected = False
        self._user_turn_count = 0
        self._saw_user_speech = False
        self._nudged = False
        self._giving_up = False
        self._consecutive_confusion = 0
        self._greeting_played = False

        self._nudge_task: asyncio.Task | None = None
        self._silence_task: asyncio.Task | None = None
        self._max_call_task: asyncio.Task | None = None

    def attach_task(self, task: PipelineTask):
        self._task = task

    # ── transcript persistence (parity: postTurn from livekit-agent.js) ─────
    async def post_turn(self, *, role: str, text: str, tool_name: str | None = None,
                         tool_args: dict | None = None, tool_result: str | None = None,
                         stt_confidence: float | None = None):
        shop = self.ctx.get("shop")
        shopify_order_id = self.ctx.get("entity_ref")
        if not shop or not shopify_order_id:
            # sandbox / demo call without entity context — skip persistence,
            # same guard as turnPersistKey() returning falsy in the JS source.
            return
        turn_index = self._turn_index
        self._turn_index += 1
        payload = {
            "shop": shop,
            "shopify_order_id": str(shopify_order_id),
            "room_name": self.room_name,
            "sip_call_id": self.sip_call_id,
            "turn_index": turn_index,
            "role": role,
            "text": text or "",
            "lang": self.ctx.get("lang") or STT_LANG,
            "tool_name": tool_name,
            "tool_args": tool_args,
            "tool_result": tool_result,
            "stt_confidence": stt_confidence,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    TURN_WEBHOOK_URL, json=payload,
                    headers={"X-COD-Tool-Secret": TOOL_SECRET},
                ) as r:
                    if r.status >= 300:
                        txt = await r.text()
                        logger.warning(f"[turn-persist] HTTP {r.status} for {role} turn #{turn_index}: {txt[:200]}")
        except Exception as e:
            # Fire-and-forget: a webhook outage must never affect the call.
            logger.warning(f"[turn-persist] fire-and-forget error on {role} turn #{turn_index}: {e}")

    # ── silence / dead-air guards (parity: armInitialSilenceGuard / armSilenceTimer
    #    / armMaxCallTimer) ───────────────────────────────────────────────────
    def arm_initial_guards(self):
        """Call once, right after the welcome finishes playing."""
        if self._terminal_fired:
            return
        self._nudge_task = asyncio.create_task(self._nudge_then_arm_silence())
        self._max_call_task = asyncio.create_task(self._max_call_backstop())

    async def _nudge_then_arm_silence(self):
        try:
            await asyncio.sleep(NO_INPUT_NUDGE_MS / 1000)
        except asyncio.CancelledError:
            return
        if self._terminal_fired or self._saw_user_speech:
            return
        self._nudged = True
        lang = (self.ctx.get("lang") or STT_LANG or "hi")
        nudge_text = ("Hello, are you able to hear me?" if str(lang).startswith("en")
                      else "Hello, kya aap mujhe sun pa rahe hain?")
        logger.info(f"[silence] parity: no reply {NO_INPUT_NUDGE_MS}ms after welcome — nudging customer")
        try:
            await self._task.queue_frame(TTSSpeakFrame(nudge_text))
        except Exception as e:
            logger.warning(f"[silence] nudge speak failed (non-fatal): {e}")
        self._arm_silence_timer()

    def _arm_silence_timer(self):
        """(Re)arm the rolling no-input/idle timer. Called once after the
        welcome and again on every final user turn."""
        if self._terminal_fired:
            return
        if self._silence_task and not self._silence_task.done():
            self._silence_task.cancel()
        self._silence_task = asyncio.create_task(self._silence_timeout())

    async def _silence_timeout(self):
        try:
            await asyncio.sleep(NO_INPUT_HANGUP_MS / 1000)
        except asyncio.CancelledError:
            return
        if self._terminal_fired:
            return
        reason = (f"user idle {NO_INPUT_HANGUP_MS}ms — silence hangup" if self._saw_user_speech
                  else f"no user speech {NO_INPUT_HANGUP_MS}ms — voicemail/dead-air hangup")
        await self._hangup_now(reason)

    async def _max_call_backstop(self):
        try:
            await asyncio.sleep(MAX_CALL_MS / 1000)
        except asyncio.CancelledError:
            return
        if self._terminal_fired:
            return
        await self._hangup_now(f"max call duration {MAX_CALL_MS}ms — backstop hangup")

    def _cancel_timers(self):
        for t in (self._nudge_task, self._silence_task, self._max_call_task):
            if t and not t.done():
                t.cancel()

    async def _hangup_now(self, reason: str):
        logger.warning(f"[hangup] parity: {reason}")
        self._cancel_timers()
        if not self._task:
            return
        try:
            await self._task.cancel(reason=reason)
        except Exception as e:
            logger.warning(f"[hangup] task.cancel failed (non-fatal): {e}")

    def mark_terminal(self):
        """Called by the terminal-tool handlers below (confirm/cancel/human/
        callback). A terminal tool owns the post-farewell hangup
        (_end_call_after_closing); disarm our guards so they don't race it."""
        self._terminal_fired = True
        self._cancel_timers()

    def on_bot_stopped_speaking(self):
        """First BotStoppedSpeakingFrame == the welcome finished playing.
        Approximates livekit-agent.js's welcomeHandle.waitForPlayout()."""
        if self._greeting_played:
            return
        self._greeting_played = True
        self.arm_initial_guards()

    # ── frame handlers (called by CallSafetyObserver) ───────────────────────
    async def on_user_transcript(self, text: str):
        if self._terminal_fired:
            return
        self._user_turn_count += 1
        self._saw_user_speech = True
        if self._nudge_task and not self._nudge_task.done():
            self._nudge_task.cancel()
        self._arm_silence_timer()

        if not self._voicemail_detected and self._user_turn_count <= 4:
            for pattern in VOICEMAIL_PATTERNS:
                if pattern.search(text):
                    self._voicemail_detected = True
                    logger.warning(
                        f"[voicemail] parity: detected on user turn #{self._user_turn_count}: "
                        f"{text!r} (matched {pattern.pattern!r})"
                    )
                    asyncio.create_task(self.post_turn(
                        role="tool", text="voicemail_detected", tool_name="voicemail_detected",
                        tool_args={"transcript": text}, tool_result="hangup",
                    ))
                    await self._hangup_now("voicemail detected")
                    return

        asyncio.create_task(self.post_turn(role="user", text=text))

    async def on_assistant_turn(self, text: str):
        asyncio.create_task(self.post_turn(role="assistant", text=text))

        if self._terminal_fired or self._giving_up:
            return
        if CONFUSION_RE.search(text or ""):
            self._consecutive_confusion += 1
            if self._consecutive_confusion >= MAX_CONFUSION_TURNS:
                self._giving_up = True
                self._cancel_timers()
                lang = (self.ctx.get("lang") or STT_LANG or "hi")
                close_text = (
                    "Sorry, I am not able to hear you clearly. We will call you again shortly. Thank you."
                    if str(lang).startswith("en") else
                    "Maaf kijiye, aapki awaaz saaf nahi aa rahi hai. Hum aapko thodi der mein dobara call karenge. Dhanyawaad."
                )
                logger.warning(
                    f"[anti-loop] parity: {self._consecutive_confusion} consecutive unclear "
                    "replies — closing gracefully"
                )
                asyncio.create_task(self._close_for_confusion(close_text))
        else:
            self._consecutive_confusion = 0

    async def _close_for_confusion(self, close_text: str):
        if self._task:
            try:
                await self._task.queue_frame(TTSSpeakFrame(close_text))
            except Exception as e:
                logger.warning(f"[anti-loop] close speak failed (non-fatal): {e}")
        try:
            await asyncio.sleep(CONFUSION_CLOSE_DELAY_S)
        except asyncio.CancelledError:
            return
        await self._hangup_now("anti-loop: repeated unintelligible input")


class CallSafetyObserver(BaseObserver):
    """parity: non-intrusive pipeline observer feeding CallGuards.

    Watches frames flow through the pipeline (without being inserted as a
    pipeline element — see pipecat.observers.base_observer.BaseObserver)
    for TranscriptionFrame (final user turns, mirrors LiveKit's
    UserInputTranscribed with ev.isFinal) and LLMContextAssistantTurnFrame
    (a completed assistant turn's full text, mirrors LiveKit's
    ConversationItemAdded for role=assistant). Frame instances are pushed
    once per pipeline hop, so a single logical turn can be observed more than
    once as it travels between processors — dedupe on frame.id, same pattern
    pipecat.pipeline.worker.IdleFrameObserver uses internally.
    """

    def __init__(self, guard: CallGuards):
        super().__init__()
        self._guard = guard
        self._seen_ids: set[int] = set()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        if frame.id in self._seen_ids:
            return
        self._seen_ids.add(frame.id)
        # Bound memory on very long calls; the id space is monotonic per
        # process so dropping old ids once we're far past them is safe.
        if len(self._seen_ids) > 4000:
            self._seen_ids.clear()
            self._seen_ids.add(frame.id)

        if isinstance(frame, TranscriptionFrame):
            await self._guard.on_user_transcript(frame.text or "")
        elif isinstance(frame, LLMContextAssistantTurnFrame):
            await self._guard.on_assistant_turn(frame.text or "")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._guard.on_bot_stopped_speaking()


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

    # parity: safety/parity guards (max-call backstop, silence nudge + rolling
    # idle timer, voicemail detection, anti-loop confusion closer, transcript
    # persistence) — see CallGuards / CallSafetyObserver above.
    guard = CallGuards(ctx)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=16000,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[CallSafetyObserver(guard)],
    )
    guard.attach_task(task)

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
            # parity: transcript persistence (from livekit-agent.js postTurn,
            # FunctionToolsExecuted handler) — capture the tool call itself.
            asyncio.create_task(guard.post_turn(
                role="tool", text=tool_name, tool_name=tool_name,
                tool_args=extra, tool_result=detail,
            ))
            # A terminal tool owns the post-farewell hangup below — disarm the
            # silence/max-call guards so they don't race it (parity:
            # terminalToolFired in livekit-agent.js).
            guard.mark_terminal()
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
        # The greeting is injected directly as a TTSSpeakFrame (bypasses the
        # LLM context aggregator), so it never produces a
        # LLMContextAssistantTurnFrame for CallSafetyObserver to see —
        # persist it explicitly. Guard timers (nudge/silence/max-call) are
        # armed separately, on the first BotStoppedSpeakingFrame (see
        # CallGuards.on_bot_stopped_speaking), i.e. once the greeting finishes
        # playing — parity with livekit-agent.js's welcomeHandle.waitForPlayout().
        asyncio.create_task(guard.post_turn(role="assistant", text=greeting))
        await task.queue_frame(TTSSpeakFrame(greeting))

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(transport, client):
        logger.info("cod-pipecat: client disconnected")
        guard.mark_terminal()
        await task.cancel()

    runner = PipelineRunner(handle_sigint=handle_sigint)
    await runner.run(task)
