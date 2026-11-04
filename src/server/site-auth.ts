import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'firehose_session';
const sessionSeconds = 24 * 60 * 60;

function signature(value: string, password: string): string {
  return createHmac('sha256', password).update(`firehose-session:${value}`).digest('hex');
}

function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function authenticated(request: Request, password: string): boolean {
  const cookie = request.headers.get('cookie')?.split(';')
    .map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const token = cookie?.slice(cookieName.length + 1) ?? '';
  const match = /^(\d+)\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  return expires > Date.now() && expires <= Date.now() + sessionSeconds * 1000
    && equal(match[3]!, signature(`${match[1]}.${match[2]}`, password));
}

function passwordPage(error = ''): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Firehose — Enter password</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; background: #fff; color: #000; font-family: 'Times New Roman', Times, serif; }
    main { width: 100%; max-width: 32rem; border: 1px solid #aaa; padding: clamp(1.5rem, 6vw, 3rem); }
    h1 { margin: 0 0 1rem; font-size: 2.5rem; }
    p { line-height: 1.5; }
    label { display: block; margin: 1.5rem 0 .5rem; }
    input, button { width: 100%; padding: .85rem; font: inherit; font-size: 1.1rem; border: 1px solid #aaa; border-radius: 0; }
    button { margin-top: 1rem; background: #efefef; color: #000; cursor: pointer; }
    .error { color: #a00000; }
    .note { margin-bottom: 0; color: #444; font-size: .9rem; }
  </style>
</head>
<body>
  <main>
    <h1>Firehose</h1>
    <p>Enter the site password to continue.</p>
    <form method="post">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus ${error ? 'aria-invalid="true" aria-describedby="password-error"' : ''}>
      ${error ? `<p class="error" id="password-error" role="alert">${error}</p>` : ''}
      <button type="submit">Unlock</button>
    </form>
    <p class="note">You’ll stay signed in for 24 hours.</p>
  </main>
</body>
</html>`, {
    status: error ? 401 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Return a response when access is blocked or a password is submitted. */
export async function checkSitePassword(
  request: Request,
  password = process.env.SITE_PASSWORD,
): Promise<Response | null> {
  if (!password) return null;
  const url = new URL(request.url);
  // Caddy terminates TLS and preserves Host while forwarding HTTP to Bun.
  const externalUrl = new URL(url);
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto === 'https' || forwardedProto === 'http') {
    externalUrl.protocol = `${forwardedProto}:`;
  }

  if (url.pathname === '/' && request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin && origin !== externalUrl.origin) {
      return new Response('Forbidden', { status: 403 });
    }
    let submitted: FormDataEntryValue | null = null;
    try { submitted = (await request.formData()).get('password'); } catch { /* Invalid form. */ }
    if (typeof submitted !== 'string' || !equal(submitted, password)) {
      return passwordPage('Incorrect password. Please try again.');
    }
    const expires = Date.now() + sessionSeconds * 1000;
    const value = `${expires}.${randomBytes(32).toString('hex')}`;
    const secure = externalUrl.protocol === 'https:';
    return new Response(null, {
      status: 303,
      headers: {
        Location: url.searchParams.get('next') === '/admin' ? '/admin' : `/${url.search}`,
        'Cache-Control': 'no-store',
        'Set-Cookie': `${cookieName}=${value}.${signature(value, password)}; Path=/; Max-Age=${sessionSeconds}; Expires=${new Date(expires).toUTCString()}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      },
    });
  }

  if (authenticated(request, password)) return null;
  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(null, { status: 303, headers: { Location: '/?next=/admin', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/' && request.method === 'GET') return passwordPage();
  return new Response('Password required. Reload the page to sign in.', {
    status: 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}
