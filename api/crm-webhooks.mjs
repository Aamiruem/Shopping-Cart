// Provider webhooks for the CRM (/api/webhooks/:provider, see vercel.json and api/_crm_webhooks.mjs). A web-standard
// handler, because signatures are checked against the exact bytes the provider sent.
import { query } from './_auth.mjs';
import { handleProviderWebhook } from './_crm_webhooks.mjs';
import { siteUrl } from './_messaging.mjs';

async function run(request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') || '';
  // The signed URL is the public one the provider called, without the rewrite's added query parameter
  url.searchParams.delete('provider');
  const publicUrl = `${siteUrl() || url.origin}/api/webhooks/${provider}${url.search}`;
  try {
    const raw = request.method === 'POST' ? await request.text() : '';
    const out = await handleProviderWebhook(provider, { method: request.method, url: publicUrl, headers: Object.fromEntries(request.headers), raw }, { db: query });
    if (out.text !== undefined) return new Response(out.text, { status: out.status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    return Response.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(`webhook ${provider} failed`, err.message);
    return Response.json({ error: 'Webhook error' }, { status: 500 }); // the provider retries
  }
}

export const GET = run;
export const POST = run;
