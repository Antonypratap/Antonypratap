// POST /api/subscribe: store a newsletter signup in Cloudflare KV.
// Setup (once, in the Cloudflare dashboard): Workers & Pages → KV → create a
// namespace (e.g. "nevervoid-subscribers"), then in the Pages project →
// Settings → Bindings → add a KV binding named SUBSCRIBERS to it.
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export async function onRequestPost({ request, env }) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const reply = (ok, message, status = 200) =>
    wantsJson
      ? new Response(JSON.stringify({ ok, message }), { status, headers: { 'content-type': 'application/json' } })
      : Response.redirect(new URL(ok ? '/subscribed' : '/subscribed?error=1', request.url).toString(), 303);
  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(false, 'Please enter a valid email address.', 400);
  }
  if (String(form.get('website') || '')) return reply(true, "You're subscribed. Thank you!"); // honeypot: bots
  const email = String(form.get('email') || '').trim().toLowerCase();
  const source = String(form.get('source') || '').slice(0, 60);
  if (email.length > 254 || !EMAIL.test(email)) return reply(false, 'Please enter a valid email address.', 400);
  if (!env.SUBSCRIBERS) return reply(false, 'Subscriptions are not switched on yet. Please WhatsApp us instead.', 503);
  const key = `sub:${email}`;
  if (!(await env.SUBSCRIBERS.get(key))) {
    await env.SUBSCRIBERS.put(key, JSON.stringify({ email, source, at: new Date().toISOString() }));
  }
  return reply(true, "You're subscribed. Thank you!");
}
