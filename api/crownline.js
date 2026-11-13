import worker from '../worker/index.js';

const cookies = { access: 'crownline_access', refresh: 'crownline_refresh' };
const redirect = path => new Response(null, { status: 303, headers: { location: path } });
const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

function safeReturn(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/dashboard';
  const url = new URL(value, 'https://crownline.invalid');
  return ['/play', '/dashboard', '/profile'].includes(url.pathname) ? url.pathname + url.search : '/dashboard';
}

function authPage(message = '') {
  return html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sign in · Crownline</title><style>body{color-scheme:dark;background:#151418;color:#f4efe3;font:16px system-ui;max-width:420px;margin:10vh auto;padding:20px}a{color:#f4c775}label,input{display:block}input{width:100%;box-sizing:border-box;margin:6px 0 16px;padding:10px}button{padding:10px;margin-right:8px}</style>
    <a href="/">Crownline</a><h1>Sign in to Crownline</h1>
    <form method="post"><label>Email<input name="email" type="email" autocomplete="email" required></label>
    <label>Password<input name="password" type="password" required></label>
    <button name="mode" value="login">Sign in</button><button name="mode" value="signup">Create account</button></form>
    <p role="status">${message}</p></html>`);
}

function setSession(response, session) {
  for (const [type, name] of Object.entries(cookies)) {
    const maxAge = session ? (type === 'access' ? session.expires_in : 2592000) : 0;
    response.headers.append('set-cookie', `${name}=${encodeURIComponent(session?.[type + '_token'] ?? '')}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
  }
}

function supabaseRequest(path, key, options = {}) {
  const { token, body, method } = options;
  return fetch(new URL(path, process.env.SUPABASE_URL), {
    method,
    headers: {
      apikey: key,
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function database() {
  const key = process.env.SUPABASE_SECRET_KEY;
  const request = async (query, body) => {
    const result = await supabaseRequest('/rest/v1/crownline_state?id=eq.1&' + query, key, body ? { method: 'PATCH', body } : {});
    if (!result.ok) throw Error('Supabase state request failed (' + result.status + ')');
    return result.json();
  };
  return { prepare(sql) {
    if (sql.startsWith('SELECT')) return { async first() {
      const [row] = await request('select=revision,data');
      return row;
    }};
    return { bind(data, revision) { return { async run() {
      const updated = await request('revision=eq.' + revision, { revision: revision + 1, data });
      return { meta: { changes: updated.length } };
    }}; }};
  }};
}

async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/crownline') {
    const path = url.searchParams.get('_crownline_path');
    if (!['/', '/play', '/dashboard', '/profile', '/api', '/signin-with-chatgpt', '/signout-with-chatgpt'].includes(path)) {
      return new Response('Not found', { status: 404 });
    }
    url.pathname = path;
    url.searchParams.delete('_crownline_path');
  }
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!process.env.SUPABASE_URL || !key || !process.env.SUPABASE_SECRET_KEY) {
    return new Response('Crownline requires its Supabase environment variables.', { status: 503 });
  }
  const auth = (path, options) => supabaseRequest('/auth/v1/' + path, key, options);
  const readCookie = name => (request.headers.get('cookie') ?? '').split('; ')
    .find(cookie => cookie.startsWith(name + '='))?.slice(name.length + 1);
  const access = readCookie(cookies.access);
  const refresh = readCookie(cookies.refresh);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) {
    return new Response('Invalid request origin.', { status: 403 });
  }
  const returnTo = safeReturn(url.searchParams.get('returnTo'));
  if (url.pathname === '/signin-with-chatgpt') {
    if (request.method === 'GET') return authPage();
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const form = await request.formData();
    const signup = form.get('mode') === 'signup';
    const email = form.get('email'), password = form.get('password');
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return authPage('Enter your email and password.');
    const endpoint = signup ? 'signup?redirect_to=' + encodeURIComponent(url.origin + '/signin-with-chatgpt') : 'token?grant_type=password';
    const result = await auth(endpoint, { method: 'POST', body: { email, password } });
    if (!result.ok) return authPage(signup ? 'Could not create the account. Check your email and password, or try again later.' : 'Could not sign in. Check your credentials and confirm your email.');
    const session = await result.json();
    if (!session.access_token) return authPage('Check your email to confirm your account, then sign in.');
    const response = redirect(returnTo);
    setSession(response, session);
    return response;
  }
  if (url.pathname === '/signout-with-chatgpt') {
    if (access) await auth('logout?scope=local', { method: 'POST', token: access });
    const response = redirect('/');
    setSession(response, null);
    return response;
  }
  let verified = access ? await auth('user', { token: access }) : null;
  let session;
  if (!verified?.ok && refresh) {
    const result = await auth('token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
    if (result.ok) {
      session = await result.json();
      verified = await auth('user', { token: session.access_token });
    }
  }
  const headers = new Headers(request.headers);
  headers.delete('oai-authenticated-user-id');
  if (verified?.ok) {
    const user = await verified.json();
    if (user.id) headers.set('oai-authenticated-user-id', user.id);
  }
  const result = await worker.fetch(new Request(url, new Request(request, { headers })), { DB: database(), authLabel: 'Sign in with email' });
  const response = new Response(result.body, result);
  if (session && verified?.ok) setSession(response, session);
  return response;
}

export default {
  async fetch(request) {
    try {
      const response = await handle(request);
      const result = new Response(response.body, response);
      result.headers.set('cache-control', 'private, no-store');
      return result;
    } catch (error) {
      console.error(error.message);
      return new Response('Crownline is temporarily unavailable.', { status: 503 });
    }
  },
};
