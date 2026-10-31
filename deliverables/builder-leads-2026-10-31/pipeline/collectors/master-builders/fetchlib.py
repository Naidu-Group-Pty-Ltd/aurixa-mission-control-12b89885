"""Polite fetch helper using plain curl (curl's own default User-Agent, no spoofing).
~1 req/s per host, exponential backoff on transient errors.
Raises Blocked on 403/429 or challenge pages unless the status is explicitly allowed
(used only for app-level JSON nonce-expiry responses)."""
import os, time, subprocess, urllib.parse, tempfile

class Blocked(Exception):
    pass

_last = {}
JAR_DIR = '/tmp/leads/agents/mba/scripts/.jars'
os.makedirs(JAR_DIR, exist_ok=True)
CHALLENGE_MARKERS = ('<title>Client Challenge</title>', '<title>Just a moment...</title>', 'error code: 1010', 'error code: 1020')


def _throttle(host, gap):
    d = time.time() - _last.get(host, 0)
    if d < gap:
        time.sleep(gap - d)
    _last[host] = time.time()


def fetch(url, data=None, headers=None, gap=1.05, tries=5, allow_status=(), out=None, method=None):
    host = urllib.parse.urlparse(url).netloc
    jar = os.path.join(JAR_DIR, host.replace(':', '_') + '.txt')
    if isinstance(data, dict):
        data = urllib.parse.urlencode(data, doseq=True)
    delay = 3
    for attempt in range(tries):
        _throttle(host, gap)
        with tempfile.NamedTemporaryFile(delete=False) as tf:
            tmp = tf.name
        cmd = ['curl', '-sS', '--compressed', '--max-time', '60', '-b', jar, '-c', jar, '-o', tmp, '-w', '%{http_code}']
        for k, v in (headers or {}).items():
            cmd += ['-H', f'{k}: {v}']
        if data is not None:
            cmd += ['--data-binary', '@-']
        if method:
            cmd += ['-X', method]
        cmd.append(url)
        p = subprocess.run(cmd, input=(data.encode() if isinstance(data, str) else data), capture_output=True)
        body = open(tmp, 'rb').read()
        os.unlink(tmp)
        try:
            status = int(p.stdout.decode().strip() or 0)
        except ValueError:
            status = 0
        if p.returncode != 0 or status == 0:
            if attempt < tries - 1:
                time.sleep(delay); delay *= 2
                continue
            raise RuntimeError(f'curl failed rc={p.returncode} {p.stderr[:200]} {url}')
        head = body[:4000].decode('utf-8', 'replace')
        if any(m in head for m in CHALLENGE_MARKERS):
            raise Blocked(f'challenge/WAF block ({status}) {url}: {head[:120]!r}')
        if status in allow_status:
            return status, body
        if status in (403, 429):
            raise Blocked(f'{status} {url}')
        if status in (500, 502, 503, 504, 520, 522, 524) and attempt < tries - 1:
            time.sleep(delay); delay *= 2
            continue
        if out and status == 200:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, 'wb') as f:
                f.write(body)
        return status, body
    raise RuntimeError('exhausted retries ' + url)
