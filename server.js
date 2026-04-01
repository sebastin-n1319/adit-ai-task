const express = require('express');
const path    = require('path');
const app     = express();

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
      /* Pass token via URL hash — never sent to any server */
      res.redirect('/#token=' + encodeURIComponent(data.access_token));
    } else {
      console.error('Token exchange failed:', JSON.stringify(data));
      res.redirect('/?login_error=token_exchange_failed');
    }
  } catch (e) {
    console.error('Callback error:', e.message);
    res.redirect('/?login_error=server_error');
  }
});

/* ── Health check ── */
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Adit AI server running on port ' + PORT);
});
