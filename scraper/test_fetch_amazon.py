import contextlib
import io
import json
import sys
import types
import unittest
from unittest.mock import patch

import fetch_amazon


class FetcherTests(unittest.TestCase):
    def run_fetch(self, url='https://www.amazon.com/dp/B012345678', final_url=None, body=b'<html>review</html>'):
        response = types.SimpleNamespace(status=200, url=final_url or url, encoding='utf-8', body=body)
        fetcher = types.SimpleNamespace(get=lambda *args, **kwargs: response)
        module = types.ModuleType('scrapling.fetchers')
        module.Fetcher = fetcher
        output = io.StringIO()
        with patch.dict(sys.modules, {'scrapling.fetchers': module}), patch('sys.stdin', io.StringIO(json.dumps({'url': url}))), contextlib.redirect_stdout(output):
            fetch_amazon.main()
        return json.loads(output.getvalue())

    def test_public_response_protocol(self):
        self.assertEqual(self.run_fetch()['html'], '<html>review</html>')

    def test_reject_localhost_and_credentials(self):
        for url in ['http://www.amazon.com/', 'https://127.0.0.1/', 'https://user:secret@www.amazon.com/', 'https://www.amazon.com:8080/']:
            with self.assertRaises(ValueError):
                self.run_fetch(url=url)

    def test_reject_foreign_redirect(self):
        with self.assertRaises(ValueError):
            self.run_fetch(final_url='https://example.com/')

    def test_limit_response_size(self):
        with self.assertRaises(ValueError):
            self.run_fetch(body=b'x' * (6 * 1024 * 1024 + 1))


if __name__ == '__main__':
    unittest.main()
