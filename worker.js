/**
 * Free WhatsApp AI Agent — single-file Cloudflare Worker
 * ------------------------------------------------------
 * Stack: WhatsApp Cloud API (free service replies) + Gemini free tier + Cloudflare Workers free plan.
 *
 * Set these in your Worker's Settings → Variables and Secrets:
 *   WA_TOKEN         (secret)  Meta access token (temporary from API Setup, or permanent System User token)
 *   PHONE_NUMBER_ID  (text)    The "Phone number ID" shown on Meta's WhatsApp → API Setup page
 *   VERIFY_TOKEN     (text)    Any random string you invent — you'll type the same one into Meta's webhook config
 *   GEMINI_API_KEY   (secret)  Free key from https://aistudio.google.com → "Get API key"
 *   SYSTEM_PROMPT    (text, optional)  Personality/instructions for your agent
 *
 * No dependencies. Paste this whole file into the Cloudflare dashboard editor and Deploy.
 */

const GRAPH_VERSION = "v23.0";
const GEMINI_MODEL = "gemini-2.5-flash";

// Best-effort dedupe: Meta retries webhooks, and we don't want to answer twice.
const seen = new Set();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Webhook verification — Meta calls this once when you save the webhook URL.
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
        return new Response(challenge ?? "", { status: 200 });
      }
      return new Response("Verification failed: check VERIFY_TOKEN", { status: 403 });
    }

    // 2) Incoming events (messages, delivery receipts, ...).
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      // Acknowledge immediately so Meta doesn't retry; do the real work in the background.
      ctx.waitUntil(handleEvent(body, env).catch((err) => console.error("handleEvent:", err)));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("WhatsApp agent is running.", { status: 200 });
  },
};

async function handleEvent(body, env) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return; // status updates (sent/delivered/read) — ignore

  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);

  const from = msg.from; // sender's number in international format, e.g. "8613800000000"

  let reply;
  if (msg.type !== "text") {
    reply = "Sorry, I can only read text messages right now. Please type your message.";
  } else {
    reply = await askGemini(msg.text.body, env);
  }

  await sendWhatsApp(from, reply, env);
}

async function askGemini(userText, env) {
  const system =
    env.SYSTEM_PROMPT ||
    "You are a helpful WhatsApp assistant. Reply briefly (1-3 sentences), " +
      "in the same language the user writes in. Be friendly and practical.";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
      }),
    }
  );

  if (!res.ok) {
    console.error("Gemini error:", res.status, await res.text());
    return "Sorry, my AI brain hiccupped. Please try again in a moment.";
  }

  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  return text || "Hmm, I couldn't come up with a reply. Could you rephrase that?";
}

async function sendWhatsApp(to, text, env) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: text.slice(0, 4096) }, // WhatsApp text limit
      }),
    }
  );

  if (!res.ok) console.error("WhatsApp send error:", res.status, await res.text());
}
