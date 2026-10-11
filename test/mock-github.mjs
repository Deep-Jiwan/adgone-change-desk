// Minimal in-process fake of the parts of GitHub's REST API (and OAuth web flow) that Change Desk uses.
import http from 'node:http';

export function startMockGithub(port) {
  const state = { issues: [], hooks: [], comments: [], calls: [], nextIssue: 1, nextHook: 100, nextComment: 5000, failIssueCreate: 0 };
  const TOKENS = { 'good-token': 'octo', 'oauth-token-xyz': 'octo-oauth' };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* form data etc. */ }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    state.calls.push({ method: req.method, path, body });

    // OAuth web flow
    if (req.method === 'POST' && path === '/login/oauth/access_token')
      return send(res, 200, body.code === 'good-code' ? { access_token: 'oauth-token-xyz', token_type: 'bearer' } : { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });

    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const login = TOKENS[token];
    if (!login) return send(res, 401, { message: 'Bad credentials' });
    if (path === '/user') return send(res, 200, { login });

    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const name = `${m[1]}/${m[2]}`;
      if (m[2] === 'private') return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { full_name: name, html_url: `https://github.com/${name}`, has_issues: m[2] !== 'noissues', permissions: { push: m[2] !== 'readonly', admin: false } });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/hooks(?:\/(\d+))?$/.exec(path);
    if (m) {
      if (req.method === 'GET') return send(res, 200, state.hooks.filter((h) => h.repo === m[1]));
      if (req.method === 'POST') { const hook = { id: state.nextHook++, repo: m[1], ...body }; state.hooks.push(hook); return send(res, 201, hook); }
      const hook = state.hooks.find((h) => h.id === Number(m[2]));
      if (!hook) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'PATCH') { Object.assign(hook, body); return send(res, 200, hook); }
      if (req.method === 'DELETE') { state.hooks.splice(state.hooks.indexOf(hook), 1); return send(res, 204); }
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
    if (m && req.method === 'POST') {
      if (state.failIssueCreate > 0) { state.failIssueCreate--; return send(res, 500, { message: 'Server Error' }); }
      const issue = { number: state.nextIssue++, repo: m[1], state: 'open', labels: [...(body.labels || [])], title: body.title, body: body.body, html_url: `https://github.com/${m[1]}/issues/${state.nextIssue - 1}` };
      state.issues.push(issue);
      return send(res, 201, issue);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/comments|\/labels(?:\/(.+))?)?$/.exec(path);
    if (m) {
      const issue = state.issues.find((i) => i.repo === m[1] && i.number === Number(m[2]));
      if (!issue) return send(res, 404, { message: 'Not Found' });
      if (!m[3] && req.method === 'PATCH') { Object.assign(issue, body); return send(res, 200, issue); }
      if (m[3] === '/comments' && req.method === 'POST') { const c = { id: state.nextComment++, issue: issue.number, body: body.body }; state.comments.push(c); return send(res, 201, c); }
      if (m[3] === '/labels' && req.method === 'POST') { issue.labels.push(...body.labels); return send(res, 200, issue.labels); }
      if (m[4] && req.method === 'DELETE') { const name = decodeURIComponent(m[4]); const i = issue.labels.indexOf(name); if (i < 0) return send(res, 404, { message: 'Label does not exist' }); issue.labels.splice(i, 1); return send(res, 200, issue.labels); }
    }
    send(res, 404, { message: `mock: no route for ${req.method} ${path}` });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, close: () => server.close() })));
}
