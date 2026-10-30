"""One bounded, public Amazon HTTP fetch. No browser or challenge solving."""
import json
import logging
import sys
from urllib.parse import urlsplit


def allowed_url(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https'
                and parsed.hostname in ('amazon.com', 'www.amazon.com')
                and parsed.port in (None, 443)
                and not parsed.username and not parsed.password)
    except ValueError:
        return False


def main():
    request = json.loads(sys.stdin.read(8192))
    url = request.get('url', '')
    if not allowed_url(url):
        raise ValueError('Only public Amazon HTTPS URLs are supported')
    from scrapling.fetchers import Fetcher
    logging.getLogger('scrapling').setLevel(logging.ERROR)
    page = Fetcher.get(
        url,
        timeout=min(20, max(1, float(request.get('timeoutSeconds', 8)))),
        retries=1,
        follow_redirects='safe',
        headers={'Accept-Language': 'en-US,en;q=0.9'},
    )
    final_url = str(page.url)
    if not allowed_url(final_url):
        raise ValueError('Amazon redirected outside the allowed destination')
    html = page.body.decode(page.encoding or 'utf-8', errors='replace')
    if len(html.encode('utf-8')) > 6 * 1024 * 1024:
        raise ValueError('Response exceeds the HTML size limit')
    print(json.dumps({'status': page.status, 'url': final_url, 'html': html}, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
