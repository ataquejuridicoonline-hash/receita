'use strict';
const { timingSafeEqual } = require('node:crypto');
const CLARITY_ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';

function respond(res, status, data) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(data);
}
function allowed(req) {
  const expected = process.env.KIWIFY_REPORT_TOKEN;
  if (!expected || expected.length < 24) return false;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function stripTrackingUrl(value) {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol)) return null;
    return u.origin + u.pathname;
  } catch (_) {
    return null;
  }
}
function safeMetricData(information) {
  const allowedFields = new Set([
    'totalSessionCount','totalBotSessionCount','distantUserCount','distinctUserCount',
    'activeTime','engagementTime','scrollDepth','averageScrollDepth',
    'pagesPerSession','PagesPerSessionPercentage','totalCount','count',
    'rageClickCount','deadClickCount','quickbackClickCount','scriptErrorCount','errorClickCount',
    'excessiveScrollCount','sessionsCount','sessionCount',
    'Device','Browser','OS','Country','Country/Region','Source','Medium','Campaign','Channel','URL'
  ]);
  const records = [];
  for (const info of (Array.isArray(information) ? information : []).slice(0, 1000)) {
    if (!info || typeof info !== 'object') continue;
    const out = {};
    for (const [key, value] of Object.entries(info)) {
      if (!allowedFields.has(key)) continue;
      if (key === 'URL') {
        const url = stripTrackingUrl(value);
        if (url) out.URL = url;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        out[key] = value;
      } else if (typeof value === 'string') {
        if (/count|percentage|time|depth|session/i.test(key) && /^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
        else if (value.length <= 100 && !value.includes('@') && !value.includes('?')) out[key] = value;
      }
    }
    if (Object.keys(out).length) records.push(out);
  }
  return records;
}
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow','GET');
    return respond(res,405,{error:'Método não permitido'});
  }
  if (!allowed(req)) return respond(res,401,{error:'Acesso restrito. Use o código privado do painel.'});
  const token = process.env.CLARITY_API_TOKEN;
  if (!token) return respond(res,503,{error:'Variável CLARITY_API_TOKEN não encontrada na implantação de produção.'});
  const days = Number(req.query.days || 1);
  if (![1,2,3].includes(days)) return respond(res,400,{error:'Período permitido: 1, 2 ou 3 dias.'});
  // One official API call per manual consultation. Clarity limits projects to 10 per day.
  const url = new URL(CLARITY_ENDPOINT);
  url.searchParams.set('numOfDays',String(days));
  url.searchParams.set('dimension1','URL');
  url.searchParams.set('dimension2','Device');
  try {
    const upstream = await fetch(url.toString(), {
      method:'GET', headers:{Authorization:'Bearer '+token,Accept:'application/json'},
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) {
      const msg = upstream.status === 429 ? 'Limite diário do Clarity atingido (10 consultas por projeto).' :
        [401,403].includes(upstream.status) ? 'Token Clarity recusado ou sem permissão.' :
        'A API do Clarity não respondeu corretamente.';
      return respond(res,502,{error:msg,upstreamStatus:upstream.status});
    }
    const body = await upstream.json();
    if (!Array.isArray(body)) return respond(res,502,{error:'Formato inesperado da API do Clarity.'});
    const metrics = body.filter(x => x && typeof x.metricName==='string')
      .map(x=>({name:x.metricName.slice(0,80),information:safeMetricData(x.information)}))
      .filter(x=>x.information.length>0);
    return respond(res,200,{
      ok:true,source:'Microsoft Clarity Data Export API',projectId:'za6jduedtw',
      windowHours:days*24,timezone:'UTC',queriedAt:new Date().toISOString(),
      dimensions:['URL','Device'],metrics,
      limits:'Até 10 consultas por dia no Clarity; até 3 dias anteriores; relatórios agregados, sem reproduções individuais.',
      note:'Apenas sessões com consentimento e carregamento do Clarity entram na análise. Números podem diferir dos cliques da Meta.'
    });
  } catch (_) {
    return respond(res,503,{error:'Não foi possível consultar o Clarity agora. Tente pelo painel oficial.'});
  }
};