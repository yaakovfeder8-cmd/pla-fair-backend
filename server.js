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

// ════════════════════════════════════════════════════════════════════
// STREAMING ROUTES — Deepgram via direct WebSocket (no SDK)
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

  let streamSid = null;
  let dgWs = null;
  const history = [];
  let isProcessing = false;

  // Simplified Deepgram URL — minimal params
  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    model: 'nova-2',
    smart_format: 'true',
    interim_results: 'false',
  }).toString();

  try {
    dgWs = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_KEY}` },
    });

    dgWs.on('open', () => {
      console.log('✅ Deepgram WebSocket connected');
    });

    dgWs.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type !== 'Results') return;

        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript || !transcript.trim()) return;
        if (!data.is_final) return;
        if (isProcessing) return;

        console.log('🗣️  USER:', transcript);
        isProcessing = true;
        history.push({ role: 'user', content: transcript });

        try {
          const message = await claude.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 120,
            system: SYSTEM_PROMPT,
            messages: history,
          });
          const reply = message.content[0].text;
          history.push({ role: 'assistant', content: reply });
          console.log('🤖 PLA FAIR:', reply);
          await streamElevenLabsToTwilio(reply, twilioWs, streamSid);
        } catch (err) {
          console.error('AI error:', err.message);
        } finally {
          isProcessing = false;
        }
      } catch (err) {
        console.error('Deepgram message error:', err.message);
      }
    });

    dgWs.on('error', (err) => {
      console.error('Deepgram WS error:', err.message);
    });

    dgWs.on('close', (code, reason) => {
      console.log('🔌 Deepgram closed:', code, reason?.toString());
    });
  } catch (err) {
    console.error('Deepgram setup error:', err.message);
  }

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {
        case 'connected':
          console.log('📡 Twilio Stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          console.log('▶️  Stream started:', streamSid);
          (async () => {
            await new Promise(r => setTimeout(r, 200));
            const greeting = "Hello, this is pla FAIR. How can I help?";
            history.push({ role: 'assistant', content: greeting });
            await streamElevenLabsToTwilio(greeting, twilioWs, streamSid);
          })();
          break;

        case 'media':
          if (dgWs && dgWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            const audio = Buffer.from(msg.media.payload, 'base64');
            try {
              dgWs.send(audio);
            } catch (err) {
              // ignore
            }
          }
          break;

        case 'stop':
          console.log('⏹️  Stream stopped');
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            try {
              dgWs.send(JSON.stringify({ type: 'CloseStream' }));
              dgWs.close();
            } catch {}
          }
          break;
      }
    } catch (err) {
      console.error('Twilio message error:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio WS closed');
    if (dgWs && dgWs.readyState === WebSocket.OPEN) {
      try { dgWs.close(); } catch {}
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err.message);
  });
});

async function streamElevenLabsToTwilio(text, twilioWs, streamSid) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_KEY;
  if (!voiceId || !apiKey) {
    console.error('Missing ElevenLabs config');
    return;
  }

  console.log('🎙️  Generating audio for:', text.slice(0, 50));

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/basic',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('ElevenLabs failed:', response.status, errText.slice(0, 200));
      return;
    }

    let totalBytes = 0;

    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        if (twilioWs.readyState !== 1) break;
        const payload = Buffer.from(chunk).toString('base64');
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload },
        }));
        totalBytes += chunk.length;
      }
    } else if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (twilioWs.readyState !== 1) break;
        const payload = Buffer.from(value).toString('base64');
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload },
        }));
        totalBytes += value.length;
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      const payload = buf.toString('base64');
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload },
      }));
      totalBytes = buf.length;
    }

    console.log(`✅ Audio sent (${totalBytes} bytes)`);
  } catch (err) {
    console.error('ElevenLabs stream error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.send('PLA FAIR server is alive! Streaming + legacy routes ready.');
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🧠 Claude: READY`);
  console.log(`🎙️  ElevenLabs voice: ${process.env.ELEVENLABS_VOICE_ID || 'NOT SET'}`);
  console.log(`📞 Legacy inbound: /voice (Gather-based, slower but stable)`);
  console.log(`⚡ STREAMING inbound: /stream-voice (Media Streams + direct Deepgram WS)`);
});