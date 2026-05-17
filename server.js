require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '5mb' }));

const claude = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_KEY,
});

const SYSTEM_PROMPT = `You are pla FAIR, a helpful personal phone-call assistant.
You're speaking on a phone call. Keep responses VERY SHORT — 1 sentence ideally, 2 max.
Never use markdown, lists, asterisks, or special characters — your response will be read aloud.
Be warm and direct. Don't pad with filler words.`;

// ════════════════════════════════════════════════════════════════════
// LEGACY GATHER ROUTES — KEPT AS FALLBACK
// ════════════════════════════════════════════════════════════════════

const conversations = {};
const audioCache = {};
const AUDIO_TTL_MS = 5 * 60 * 1000;

const pushTokens = new Map();      // callId -> expoPushToken
const pendingRequests = new Map(); // requestId -> { resolve, timer }
const liveTranscripts = new Map(); // callId -> messages array

const escapeXml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isGoodbye = (text) => {
  const lower = text.toLowerCase().trim();
  return /\b(goodbye|good bye|bye bye|that's all|hang up|end call|talk to you later)\b/.test(lower)
    || lower === 'bye' || lower === 'thanks bye';
};

async function generateElevenLabsAudio(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_KEY;
  if (!voiceId || !apiKey) throw new Error('Missing ElevenLabs config');
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text, model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
  const id = randomUUID();
  audioCache[id] = Buffer.from(await response.arrayBuffer());
  setTimeout(() => { delete audioCache[id]; }, AUDIO_TTL_MS);
  return `${process.env.NGROK_URL}/audio/${id}`;
}

async function speak(text) {
  try {
    const url = await generateElevenLabsAudio(text);
    return `<Play>${url}</Play>`;
  } catch (err) {
    console.error('⚠️  ElevenLabs failed, fallback to Polly:', err.message);
    return `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
  }
}

const FAST_GATHER = `<Gather input="speech" action="/heard" method="POST" speechTimeout="1" speechModel="experimental_conversations" />`;

app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log('📞 [LEGACY] INBOUND:', callSid);
  conversations[callSid] = [];
  const greeting = await speak('Hello, this is pla FAIR. How can I help?');
  const noInput = await speak("I didn't hear anything. Goodbye.");
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>${greeting}${FAST_GATHER}${noInput}<Hangup/></Response>`);
});

app.post('/heard', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSaid = (req.body.SpeechResult || '').trim();
  console.log('🗣️  [LEGACY]:', userSaid || '(silence)');
  if (!conversations[callSid]) conversations[callSid] = [];
  const history = conversations[callSid];

  if (userSaid && isGoodbye(userSaid)) {
    delete conversations[callSid];
    const bye = await speak('Take care!');
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }
  if (!userSaid) {
    const repeat = await speak("Sorry, I didn't catch that.");
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${repeat}${FAST_GATHER}<Hangup/></Response>`);
    return;
  }
  history.push({ role: 'user', content: userSaid });
  let claudeResponse = "Sorry, could you repeat?";
  try {
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 120, system: SYSTEM_PROMPT, messages: history,
    });
    claudeResponse = message.content[0].text;
    history.push({ role: 'assistant', content: claudeResponse });
    console.log('🤖 [LEGACY]:', claudeResponse);
  } catch (err) {
    console.error('Claude error:', err.message);
  }
  const reply = await speak(claudeResponse);
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>${reply}${FAST_GATHER}<Hangup/></Response>`);
});

app.get('/audio/:id', (req, res) => {
  const buf = audioCache[req.params.id];
  if (!buf) return res.status(404).send('Audio not found');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', buf.length);
  res.send(buf);
});

app.post('/register-push-token', (req, res) => {
  const { callId, pushToken } = req.body || {};
  if (!callId || typeof callId !== 'string' || !pushToken || typeof pushToken !== 'string') {
    return res.status(400).json({ error: 'callId and pushToken (strings) required' });
  }
  pushTokens.set(callId, pushToken);
  console.log(`📲 Push token registered — callId: ${callId}, token: ${pushToken.slice(0, 20)}...`);
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// STREAMING WITH FULL DUPLEX INTERRUPTION (unchanged)
// ════════════════════════════════════════════════════════════════════

app.post('/stream-voice', (req, res) => {
  const callSid = req.body.CallSid;
  console.log('⚡ [STREAM] INBOUND:', callSid);
  const wsUrl = process.env.NGROK_URL.replace('https://', 'wss://') + '/stream';
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
    <Connect>
      <Stream url="${wsUrl}" />
    </Connect>
  </Response>`);
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWs) => {
  console.log('🔌 [STREAM] Twilio connected');
  let streamSid = null; let dgWs = null; const history = [];
  let isAiSpeaking = false; let currentAbortController = null; let interimUserText = ''; let isProcessing = false;
  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    encoding: 'mulaw', sample_rate: '8000', model: 'nova-2', smart_format: 'true',
    interim_results: 'true', utterance_end_ms: '1000', vad_events: 'true', endpointing: '300',
  }).toString();
  try {
    dgWs = new WebSocket(dgUrl, { headers: { Authorization: `Token ${process.env.DEEPGRAM_KEY}` } });
    dgWs.on('open', () => { console.log('✅ Deepgram connected'); });
    dgWs.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'SpeechStarted') { if (isAiSpeaking) { interruptAi(); } return; }
        if (data.type === 'Results') {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          if (!transcript || !transcript.trim()) return;
          if (!data.is_final) { interimUserText = transcript; if (isAiSpeaking && transcript.length > 2) interruptAi(); return; }
          interimUserText = transcript; return;
        }
        if (data.type === 'UtteranceEnd') {
          if (!interimUserText.trim()) return; if (isProcessing) return;
          const userSaid = interimUserText.trim(); interimUserText = '';
          isProcessing = true; history.push({ role: 'user', content: userSaid });
          try {
            const message = await claude.messages.create({
              model: 'claude-sonnet-4-5', max_tokens: 120, system: SYSTEM_PROMPT, messages: history,
            });
            const reply = message.content[0].text;
            history.push({ role: 'assistant', content: reply });
            await streamAudioToTwilio(reply);
          } catch (err) { console.error('AI error:', err.message);
          } finally { isProcessing = false; }
        }
      } catch (err) { console.error('Deepgram message error:', err.message); }
    });
    dgWs.on('error', (err) => { console.error('Deepgram WS error:', err.message); });
    dgWs.on('close', () => { console.log('🔌 Deepgram closed'); });
  } catch (err) { console.error('Deepgram setup error:', err.message); }

  function interruptAi() {
    isAiSpeaking = false;
    if (currentAbortController) { try { currentAbortController.abort(); } catch {} currentAbortController = null; }
    if (twilioWs.readyState === 1 && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
    }
  }

  async function streamAudioToTwilio(text) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const apiKey = process.env.ELEVENLABS_KEY;
    if (!voiceId || !apiKey) return;
    isAiSpeaking = true; currentAbortController = new AbortController();
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/basic' },
          body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
          signal: currentAbortController.signal,
        }
      );
      if (!response.ok) { isAiSpeaking = false; return; }
      try {
        if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
          for await (const chunk of response.body) {
            if (!isAiSpeaking) break; if (twilioWs.readyState !== 1) break;
            const payload = Buffer.from(chunk).toString('base64');
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
          }
        }
      } catch (streamErr) { if (streamErr.name !== 'AbortError') console.error('Stream error:', streamErr.message); }
    } catch (err) { if (err.name !== 'AbortError') console.error('ElevenLabs error:', err.message); }
    finally { isAiSpeaking = false; currentAbortController = null; }
  }

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.event) {
        case 'connected': break;
        case 'start':
          streamSid = msg.start.streamSid;
          (async () => {
            await new Promise(r => setTimeout(r, 200));
            const greeting = "Hello, this is pla FAIR. How can I help?";
            history.push({ role: 'assistant', content: greeting });
            await streamAudioToTwilio(greeting);
          })();
          break;
        case 'media':
          if (dgWs && dgWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            try { dgWs.send(Buffer.from(msg.media.payload, 'base64')); } catch {}
          }
          break;
        case 'stop':
          isAiSpeaking = false;
          if (currentAbortController) { try { currentAbortController.abort(); } catch {} }
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            try { dgWs.send(JSON.stringify({ type: 'CloseStream' })); dgWs.close(); } catch {}
          }
          break;
      }
    } catch (err) { console.error('Twilio message error:', err.message); }
  });

  twilioWs.on('close', () => {
    isAiSpeaking = false;
    if (currentAbortController) { try { currentAbortController.abort(); } catch {} }
    if (dgWs && dgWs.readyState === WebSocket.OPEN) { try { dgWs.close(); } catch {} }
  });
});

// ════════════════════════════════════════════════════════════════════
// VAPI WEBHOOK — for permission requests during calls
// ════════════════════════════════════════════════════════════════════

app.post('/vapi-webhook', async (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎯 VAPI WEBHOOK HIT at', new Date().toISOString());
  console.log('Body:', JSON.stringify(req.body, null, 2).slice(0, 2000));
  console.log('🔍 Body top-level keys:', Object.keys(req.body || {}));
  console.log('🔍 message keys:', Object.keys(req.body?.message || {}));
  console.log('🔍 req.body.call:', JSON.stringify(req.body?.call));
  console.log('🔍 req.body.message.call:', JSON.stringify(req.body?.message?.call));
  console.log('🔍 req.body.message.artifact:', JSON.stringify(req.body?.message?.artifact));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    const message = req.body?.message;
    const messageType = message?.type;
    const callId =
      req.body?.message?.call?.id ||
      req.body?.call?.id ||
      req.body?.message?.artifact?.callId ||
      req.body?.message?.toolCallList?.[0]?.callId ||
      null;
    console.log('📍 Resolved callId:', callId);

    if (messageType === 'conversation-update') {
      const messages = req.body.message.messages || [];
      liveTranscripts.set(callId, messages);
      console.log('📝 Transcript update —', callId, '—', messages.length, 'msgs');
      return res.json({ ok: true });
    }

    if (messageType === 'tool-calls' || messageType === 'function-call') {
      const toolCalls = message?.toolCallList || message?.toolCalls || [];
      const functionCall = message?.functionCall;
      const results = [];

      for (const toolCall of toolCalls) {
        const fnName = toolCall?.function?.name || toolCall?.name;
        const fnArgs = toolCall?.function?.arguments || toolCall?.arguments || {};
        const toolCallId = toolCall?.id;
        const args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;

        console.log(`📞 Tool call: ${fnName}`, args);

        if (fnName === 'request_permission') {
          const { category, reason } = args;
          console.log(`🔐 [VAPI] request_permission — callId: ${callId}, category: ${category}, reason: ${reason}`);

          const pushToken = pushTokens.get(callId);
          if (!pushToken) {
            console.log(`⚠️  No push token for callId: ${callId}`);
            results.push({ toolCallId, result: JSON.stringify({ approved: false, error: 'no push token' }) });
            continue;
          }

          const requestId = randomUUID();
          console.log(`📤 Sending Expo push — requestId: ${requestId}, token: ${pushToken.slice(0, 20)}...`);

          try {
            const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-encoding': 'gzip, deflate',
              },
              body: JSON.stringify({
                to: pushToken,
                title: '🔐 Permission needed: ' + category,
                body: 'AI on call wants to share your ' + category + ' — ' + reason,
                data: { requestId, category, reason, callId },
                sound: 'default',
                priority: 'high',
                categoryId: 'permission_request',
                _displayInForeground: true,
                _contentAvailable: true,
                ttl: 30,
                channelId: 'permissions',
                interruptionLevel: 'time-sensitive',
              }),
            });
            const pushBody = await pushRes.json();
            console.log(`📬 Expo push response:`, JSON.stringify(pushBody));
          } catch (pushErr) {
            console.error(`❌ Expo push failed:`, pushErr.message);
            results.push({ toolCallId, result: JSON.stringify({ approved: false, error: 'push send failed' }) });
            continue;
          }

          const decision = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              pendingRequests.delete(requestId);
              console.log(`⏱️  Timed out — requestId: ${requestId}`);
              resolve({ approved: false, timedOut: true });
            }, 25000);
            pendingRequests.set(requestId, { resolve, timer });
            console.log(`⏳ Awaiting user decision — requestId: ${requestId}`);
          });

          console.log(`🎯 Decision received — requestId: ${requestId}, approved: ${decision.approved}`);
          results.push({ toolCallId, result: JSON.stringify({ approved: decision.approved, value: decision.value }) });
        } else {
          results.push({ toolCallId, result: JSON.stringify({ error: `Unknown tool: ${fnName}` }) });
        }
      }

      if (functionCall && results.length === 0) {
        const fnName = functionCall?.name;
        const fnArgs = functionCall?.parameters || {};
        if (fnName === 'request_permission') {
          return res.json({
            result: JSON.stringify({
              approved: true,
              value: getMockValueForCategory(fnArgs?.category),
              note: '[MOCK auto-approve.]',
            }),
          });
        }
      }

      return res.json({ results });
    }

    if (messageType === 'end-of-call-report' ||
        (messageType === 'status-update' && message?.status === 'ended')) {
      if (callId) setTimeout(() => { liveTranscripts.delete(callId); }, 5 * 60 * 1000);
      console.log('🏁 Call ended — transcript cleared in 5 min:', callId);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Vapi webhook error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

function getMockValueForCategory(category) {
  const mocks = {
    ssn: String(Math.floor(1000 + Math.random() * 9000)),
    license: 'D' + Math.floor(1000000 + Math.random() * 9000000),
    insurance: 'Aetna PPO #' + Math.floor(100000 + Math.random() * 900000),
    address: '123 Main St, San Francisco, CA 94102',
    creditcard: '**** **** **** 1234',
    bank: 'Chase ****5678',
  };
  return mocks[category] || '[mock value]';
}

// ════════════════════════════════════════════════════════════════════
// IN-APP CHAT — NEW
// pla FAIR's in-app AI helper for users
// ════════════════════════════════════════════════════════════════════

const APP_HELPER_SYSTEM_PROMPT = `You are pla FAIR's in-app AI helper. You assist users INSIDE the pla FAIR mobile app.

ABOUT THE APP:
pla FAIR is an AI phone assistant. Users tell it who to call and why, and it makes the call for them — handling the entire conversation in their voice (if voice cloning is set up).

KEY APP FEATURES YOU SHOULD KNOW:
- HOME TAB: starts new calls. Pick a template (DMV, Doctor, Restaurant, etc.) → answer questions → AI calls for them.
- PLACES TAB: save spots they call regularly (Joe's Pizza, library). Has a "Find places near me" feature using Google Places.
- VAULT TAB: encrypted on-device storage for sensitive info (license, SSN, insurance, etc.). Has 3 protection levels:
  • L1 (Standard): auto-released on calls
  • L2 (Confirm): user must tap to allow each share
  • L3 (Maximum): Face ID required (coming soon)
- HISTORY TAB: every call with transcript and audio recording.
- SETTINGS TAB: voice clone (record 60s of voice for AI to use), theme, transcripts toggle.

YOUR JOB:
1. Help users understand and use the app's features
2. Help users compose what to say on a call (if they ask "what should I say to the DMV about...")
3. Suggest the right template for their situation
4. Be friendly, concise, and helpful

RULES:
- Keep responses SHORT — 2-4 sentences max unless user asks for detail
- Use plain text, no markdown, no asterisks
- If they ask something unrelated to the app, gently redirect: "I'm here to help with pla FAIR — what call do you need to make?"
- Never give legal, medical, or financial advice. Suggest they call a professional via pla FAIR.
- If user is frustrated, acknowledge it and offer specific help.

EXAMPLES:
User: "How do I clone my voice?"
You: "Go to Settings → Voice Clone, then tap the mic and read the script for about 60 seconds. Takes 2 minutes total. After it's ready, all your calls will use your voice instead of a generic one."

User: "I need to call the DMV about my license"
You: "Use the DMV templates on Home — there's options for renewing, replacing a lost license, REAL ID, and more. Pick the one that fits, fill in your state and DMV phone, and pla FAIR makes the call."`;

app.post('/chat', async (req, res) => {
  console.log('💬 CHAT request');
  try {
    const { messages, contextHints } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Build system prompt with optional dynamic context
    let systemPrompt = APP_HELPER_SYSTEM_PROMPT;
    if (contextHints && typeof contextHints === 'object') {
      const hints = [];
      if (contextHints.userName) hints.push(`The user's name is ${contextHints.userName}.`);
      if (contextHints.hasVoiceClone) hints.push(`The user has voice cloning set up.`);
      else hints.push(`The user has NOT yet set up voice cloning.`);
      if (typeof contextHints.vaultItemCount === 'number') {
        hints.push(`The user has ${contextHints.vaultItemCount} vault items saved.`);
      }
      if (typeof contextHints.placeCount === 'number') {
        hints.push(`The user has ${contextHints.placeCount} saved places.`);
      }
      if (typeof contextHints.callCount === 'number') {
        hints.push(`The user has made ${contextHints.callCount} total calls.`);
      }
      if (hints.length > 0) {
        systemPrompt += `\n\nCURRENT USER CONTEXT:\n${hints.join('\n')}`;
      }
    }

    // Sanitize messages — only role and content
    const cleanMessages = messages
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      .slice(-20); // last 20 messages max

    if (cleanMessages.length === 0 || cleanMessages[cleanMessages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'last message must be from user' });
    }

    const completion = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: cleanMessages,
    });

    const reply = completion.content?.[0]?.text || "Sorry, I couldn't generate a response.";
    console.log(`💬 → ${reply.slice(0, 80)}...`);

    return res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: err?.message || 'chat failed' });
  }
});

// ════════════════════════════════════════════════════════════════════

app.post('/vapi-permission-approve', (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔓 /vapi-permission-approve hit at', new Date().toISOString());
  console.log('Body:', JSON.stringify(req.body));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { requestId, approved, value } = req.body || {};
  if (!requestId || typeof requestId !== 'string') {
    return res.status(400).json({ error: 'requestId required' });
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    console.log(`⚠️  requestId not found or expired: ${requestId}`);
    return res.status(404).json({ error: 'request not found or expired' });
  }

  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  console.log(`✅ Resolving — requestId: ${requestId}, approved: ${approved}, value: ${value}`);
  pending.resolve({ approved: !!approved, value });
  return res.json({ ok: true });
});

app.get('/call-transcript/:callId', (req, res) => {
  res.json({ messages: liveTranscripts.get(req.params.callId) || [] });
});

app.get('/', (req, res) => {
  res.send('PLA FAIR server is alive! Streaming + legacy + Vapi webhook + chat ready.');
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🧠 Claude: READY`);
  console.log(`🎙️  ElevenLabs voice: ${process.env.ELEVENLABS_VOICE_ID || 'NOT SET'}`);
  console.log(`📞 Legacy inbound: /voice`);
  console.log(`⚡ STREAMING inbound: /stream-voice`);
  console.log(`🎯 VAPI webhook: /vapi-webhook`);
  console.log(`💬 In-app chat: /chat`);
});