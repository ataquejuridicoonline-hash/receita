'use strict';
const { timingSafeEqual } = require('node:crypto');

const BASE = 'https://public-api.kiwify.com/v1';
function authorize(req, secret) {
  if (!secret || secret.length < 24) return false;
  const received = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}
function dateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) ? value : null;
}
function amount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  const raw = await response.text();
  let body = {};
  try { body = JSON.parse(raw); } catch (_) { /* no sensitive upstream details */ }
  if (!response.ok) {
    const error = new Error('Kiwify indisponível ou autorização recusada');
    error.status = response.status;
    throw error;
  }
  return body;
}
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Método não permitido' });
  }
  if (!authorize(req, process.env.KIWIFY_REPORT_TOKEN)) {
    return send(res, 401, { error: 'Acesso restrito. Configure KIWIFY_REPORT_TOKEN no projeto Vercel e informe o código no painel privado.' });
  }
  const clientId = process.env.KIWIFY_CLIENT_ID || process.env.client_id;
  const clientSecret = process.env.KIWIFY_CLIENT_SECRET || process.env.client_secret;
  const accountId = process.env.KIWIFY_ACCOUNT_ID || process.env.account_id;
  if (![clientId, clientSecret, accountId].every(Boolean)) {
    return send(res, 503, { error: 'Configuração incompleta: confira KIWIFY_CLIENT_ID, KIWIFY_CLIENT_SECRET e KIWIFY_ACCOUNT_ID na Vercel.' });
  }
  const now = new Date();
  const today = new Date(now.getTime() - 4 * 3600 * 1000).toISOString().slice(0,10);
  const defaultStart = new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0,10);
  const start = dateString(req.query.start) || defaultStart;
  const end = dateString(req.query.end) || today;
  const days = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
  if (days < 0 || days > 89) return send(res, 400, { error: 'Escolha um período válido de até 90 dias.' });
  try {
    const form = new URLSearchParams({client_id: clientId, client_secret: clientSecret});
    const tokenData = await getJson(BASE + '/oauth/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: form
    });
    if (!tokenData.access_token) return send(res, 502, {error:'Token OAuth não retornado pela Kiwify.'});
    const headers = {
      Authorization: 'Bearer ' + tokenData.access_token,
      'x-kiwify-account-id': accountId,
      Accept: 'application/json'
    };
    const productId = process.env.KIWIFY_PRODUCT_ID || '';
    const sales = [];
    const pageSize = 100;
    let truncated = false;
    let pageCount = 0;
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({
        start_date: start, end_date: end,
        page_number: String(page), page_size: String(pageSize),
        view_full_sale_details: 'false'
      });
      if (productId) query.set('product_id', productId);
      const payload = await getJson(BASE + '/sales?' + query, {headers});
      if (!Array.isArray(payload.data)) return send(res, 502, {error:'Formato de resposta de vendas inesperado.'});
      sales.push(...payload.data);
      pageCount = page;
      const count = Number(payload.pagination?.count);
      const size = Number(payload.pagination?.page_size) || pageSize;
      if (payload.data.length < size || (Number.isFinite(count) && count > 0 && page * size >= count)) break;
      if (page === 20) truncated = true;
    }
    // Privacy: return summaries only; never return buyers' names, emails, documents, or order IDs.
    const statuses = {}, methods = {}, products = {};
    let approved = 0, refunded = 0, pending = 0, approvedNetCents = 0;
    for (const sale of sales) {
      const status = String(sale.status || 'unknown').toLowerCase();
      const method = String(sale.payment_method || 'unknown').toLowerCase();
      statuses[status] = (statuses[status] || 0) + 1;
      methods[method] = (methods[method] || 0) + 1;
      const p = String(sale.product?.name || 'Produto não informado');
      products[p] = (products[p] || 0) + 1;
      if (status === 'paid' || status === 'approved') {
        approved++;
        // Kiwify API reports monetary amounts in centavos.
        approvedNetCents += amount(sale.net_amount);
      } else if (status === 'refunded' || status === 'chargedback') refunded++;
      else if (['pending','waiting_payment','processing','authorized'].includes(status)) pending++;
    }
    return send(res, 200, {
      ok: true, source:'Kiwify API oficial', start, end,
      generatedAt:new Date().toISOString(), total:sales.length,
      paid:approved, pending, refunded, statuses, methods, products,
      netApprovedBrl:Math.round(approvedNetCents)/100,
      netAmountAvailable: sales.some(s => typeof s.net_amount === 'number'),
      incomplete: truncated, pages: pageCount,
      note:'Pedidos e receitas da Kiwify, não compras atribuídas pela Meta. Valores líquidos dependem dos campos disponibilizados pela API.'
    });
  } catch (e) {
    const status = [400,401,403,429].includes(e.status) ? 502 : 503;
    return send(res,status,{error:e.status===401||e.status===403?'Credenciais recusadas ou permissões insuficientes na Kiwify.':'Não foi possível consultar a Kiwify agora.', upstreamStatus:e.status || null});
  }
};
