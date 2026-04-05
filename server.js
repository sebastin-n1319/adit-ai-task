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

    const overdueTasks = tasks.filter(t => t.overdue);
    const highPriTasks = tasks.filter(t => t.priority === 'high');
    const critProjects = projs.filter(p => p.status === 'critical' || p.status === 'delayed');
    const onTrackProjs = projs.filter(p => p.status === 'on-track');

    const ctxText = [
      `=== USER ===`,
      `Name: ${me.name || 'unknown'} | Email: ${me.email || ''} | Today: ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}`,
      ``,
      `=== WORKSPACE KPIS ===`,
      `Total tasks: ${kpis.total||0} | Completed: ${kpis.completed||0} | Open: ${kpis.open||0} | Completion rate: ${kpis.total ? Math.round((kpis.completed/kpis.total)*100) : 0}%`,
      ``,
      `=== MY TASKS (${tasks.length} open) ===`,
      `OVERDUE (${overdueTasks.length}): ${overdueTasks.map(t => `"${t.name}" [was due ${t.due||t.due_on}]`).join(', ') || 'none'}`,
      `HIGH PRIORITY (${highPriTasks.length}): ${highPriTasks.map(t => `"${t.name}"`).join(', ') || 'none'}`,
      `ALL TASKS: ${tasks.map(t => `"${t.name}" | due:${t.due||t.due_on||'no date'} | overdue:${t.overdue?'YES':'no'} | priority:${t.priority||'normal'} | project:${t.project||'none'}`).join('\n  ')}`,
      ``,
      `=== PROJECTS (${projs.length} active) ===`,
      `AT RISK / CRITICAL (${critProjects.length}): ${critProjects.map(p => `"${p.name}" ${p.pct}% done, ${p.open||0} open tasks`).join(', ') || 'none'}`,
      `ON TRACK (${onTrackProjs.length}): ${onTrackProjs.map(p => `"${p.name}" ${p.pct}%`).join(', ') || 'none'}`,
      `ALL PROJECTS: ${projs.map(p => `"${p.name}" | ${p.pct||0}% | status:${p.status||'active'} | open:${p.open||0}`).join('\n  ')}`,
    ].join('\n');

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: `You are Adit AI — the intelligent work assistant built into Adit's task management platform for a dental software company called Adit. You have REAL, LIVE access to the user's Asana workspace data provided in every message.

YOUR CAPABILITIES:
- Analyse tasks, projects, workload, deadlines, and team performance from live Asana data
- Give specific, data-driven answers (not generic advice) — reference ACTUAL task names, project names, and numbers
- Suggest priorities, flag risks, identify patterns in the data
- Generate standups, status summaries, delegation recommendations
- Help plan sprints and estimate effort
- Answer "what should I focus on today?" with a concrete prioritised list from their REAL tasks

RESPONSE FORMAT (CRITICAL — always follow this):
- Use clean HTML formatting: <strong> for key terms, <br/> for line breaks, <ul><li> for lists
- NEVER use markdown (no **, no ##, no ---) — HTML only
- For data summaries, use: <div style="background:rgba(0,45,66,.06);padding:8px 12px;border-radius:8px;margin:6px 0;border-left:3px solid #F4891F">content here</div>
- For warnings/overdue: wrap in <span style="color:#EF4444;font-weight:700">
- For good news/done: wrap in <span style="color:#0FB77A;font-weight:700">
- Keep answers concise — lead with the most important insight first
- If referencing a specific task, bold it: <strong>"Task Name"</strong>
- End actionable responses with 1-2 short suggested follow-up questions as clickable spans

TONE: Direct, specific, data-driven. You are the user's personal chief of staff who knows exactly what's in their Asana workspace. Never be vague. If the data shows 3 overdue tasks, name them. If a project is at risk, say why based on the data.`,
      messages: [{
        role: 'user',
        content: `Live workspace data:\n${ctxText}\n\nUser question: ${question}`
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
