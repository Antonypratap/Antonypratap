// GET /api/subscribers?token=…: download all signups as CSV (owner only).
// Setup: Pages project → Settings → Variables and secrets → add a secret
// EXPORT_TOKEN (a long random string). Without it this URL returns 404.
export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token') || '';
  if (!env.EXPORT_TOKEN || token.length !== env.EXPORT_TOKEN.length || token !== env.EXPORT_TOKEN) return new Response('Not found', { status: 404 });
  if (!env.SUBSCRIBERS) return new Response('KV binding SUBSCRIBERS is missing', { status: 503 });
  const rows = [['email', 'subscribed_at', 'source']];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const v = JSON.parse((await env.SUBSCRIBERS.get(k.name)) || '{}');
      rows.push([v.email, v.at, v.source]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const csv = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="nevervoid-subscribers.csv"', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
