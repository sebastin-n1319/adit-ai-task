const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json({ limit: '2mb' }));

const CLIENT_ID     = process.env.ASANA_CLIENT_ID     || '1213835252509979';
const CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET || '';
const BASE_URL      = process.env.BASE_URL             || 'https://adit-taskai.up.railway.app';
const REDIRECT_URI  = BASE_URL + '/callback';
const PORT          = process.env.PORT || 8080;

/* ── Serve the HTML app ── */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'adit-ai-taskmanager.html'));
});

/* ── Step 1: redirect user to Asana OAuth login ── */
app.get('/auth/asana', (req, res) => {
  const url =
    'https://app.asana.com/-/oauth_authorize' +
    '?client_id='        + encodeURIComponent(CLIENT_ID) +
    '&redirect_uri='     + encodeURIComponent(REDIRECT_URI) +
    '&response_type=code' +
    '&scope=default' +
    '&state=adit-login';
  res.redirect(url);
});

/* ── Step 2: exchange code for token ── */
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?login_error=' + encodeURIComponent(error || 'no_code'));
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      code,
    });

    const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    const data = await tokenRes.json();

    if (data.access_token) {
      /* Pass both tokens via hash — never sent to any server */
      let hash = '#token=' + encodeURIComponent(data.access_token);
      if (data.refresh_token) hash += '&refresh=' + encodeURIComponent(data.refresh_token);
      res.redirect('/' + hash);
    } else {
      console.error('Token exchange failed:', JSON.stringify(data));
      res.redirect('/?login_error=token_exchange_failed');
    }
  } catch (e) {
    console.error('Callback error:', e.message);
    res.redirect('/?login_error=server_error');
  }
});

/* ── Token refresh endpoint ── */
app.get('/refresh', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'missing_token' });
  try {
    const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: token,
      }),
    });
    const data = await tokenRes.json();
    if (data.access_token) {
      res.json({ access_token: data.access_token, refresh_token: data.refresh_token || token });
    } else {
      res.status(401).json({ error: 'refresh_failed' });
    }
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

/* ── AI Ask endpoint (Claude API) ── */
app.post('/api/ask', async (req, res) => {
  const { question, context } = req.body || {};
  if (!question) return res.status(400).json({ error: 'missing_question' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json({ answer: null, fallback: true, reason: 'no_api_key' });
  }

  try {
    // Build rich context string
    const tasks  = (context?.tasks  || []).slice(0, 60);
    const projs  = (context?.projects || []).slice(0, 30);
    const me     = context?.me || {};
    const kpis   = context?.kpis || {};

    const ctxText = [
      `User: ${me.name || 'unknown'} (${me.email || ''})`,
      `Workspace KPIs: ${JSON.stringify(kpis)}`,
      `Projects (${projs.length}): ${projs.map(p => `${p.name} [${p.status||'active'}, ${p.pct||0}% done]`).join('; ')}`,
      `My Tasks (${tasks.length}): ${tasks.map(t => `"${t.name}" due:${t.due||t.due_on||'none'} overdue:${t.overdue||false} priority:${t.priority||'normal'} project:${t.project||''}`).join('; ')}`,
    ].join('\n');

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `You are Adit AI, an intelligent work assistant for Adit — a dental software company. You have access to the user's Asana workspace data. Be concise, helpful, and professional. Format your answers in clean HTML: use <strong> for emphasis, <br> for line breaks, <ul>/<li> for lists. Never use markdown syntax like ** or ##. Keep responses focused and under 300 words unless a detailed breakdown is explicitly requested.`,
      messages: [{
        role: 'user',
        content: `Workspace context:\n${ctxText}\n\nUser question: ${question}`
      }]
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body,
    });

    const data = await r.json();
    if (data.content?.[0]?.text) {
      return res.json({ answer: data.content[0].text });
    }
    console.error('Claude API error:', JSON.stringify(data));
    return res.json({ answer: null, fallback: true });
  } catch (e) {
    console.error('/api/ask error:', e.message);
    return res.json({ answer: null, fallback: true });
  }
});

/* ── Health check ── */
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Adit AI server running on port ' + PORT);
});
