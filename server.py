#!/usr/bin/env python3
"""Static workbench and bounded advisor APIs; private config is never served."""
import argparse
import base64
import hmac
import json
import os
import threading
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from advisor_service import analyze, configured
import jev_service
import jev_intake
from private_config import configuration
from catalog_sync_service import CatalogSyncHandlerMixin

ROOT = Path(__file__).resolve().parent
SLOTS = threading.BoundedSemaphore(4)
PUBLIC = {'responsive.css','calculation-numbers.js','reverse-calculation.js','capacity-lesson.html','capacity-lesson.css','capacity-lesson.js','capacity-teaching-core.js','capacity-terms.js','capacity-lesson-offline.html','parallel-layout.js','compressed-attention.js','advisor-chat.js','advisor-chat.css','influence-paths.js','causal-readable.css','advisor-jev.js','advisor-jev.css','REVIEW-20261002.md','CATALOG-REVIEW-20261002.md','JEV-ADVISOR-PLAN-20261001.md','causal-v5.js','pricing.js','engine-v5.js','solver-v5.js','catalog-ui.js','calculation-v5-ui.js','catalog.json','UPDATE-20261001.md','index.html', 'data.js', 'engine-v4.js', 'solver-v4.js', 'calculation-explain.js',
          'workbench-v4.js', 'workbench-summary.js', 'app-v4.js', 'advisor-core.js', 'impact-view.js', 'panel-harness.js',
          'serving-planning.js', 'impact-lab.js', 'impact-lab.css', 'cost-chart.js', 'cost-chart.css', 'vendor/echarts-6.1.0/echarts.min.js',
          'vendor/echarts-6.1.0/LICENSE', 'vendor/echarts-6.1.0/NOTICE',
          'mind-map.js', 'mind-map.css', 'MINDMAP-V4.4.2.md', 'causal-chain.js', 'causal-chain.css', 'CAUSAL-V4.4.1.md', 'styles-v3.css', 'styles-v4.css', 'calculation-explain.css', 'harness.css',
          'HARNESS-V4.4.md', 'CALCULATION-V4.1.md', 'CALCULATION-V4.3.md', 'CALCULATION-V4.md',
          'CALCULATION-AUDIT-20260907.md', 'CATALOG-UPDATE-20260907.md'}


PUBLIC.add('catalog-sync-ui.js')
PUBLIC.update({'calculation-audit.html','calculation-audit.svg'})

def check_auth(header, settings=None):
    settings = configuration() if settings is None else settings
    user, password = settings.get('PANEL_USER', ''), settings.get('PANEL_PASS', '')
    if not user:
        return True
    if not password or not header or not header.startswith('Basic '):
        return False
    try:
        decoded = base64.b64decode(header[6:], validate=True).decode('utf-8')
        u, _, p = decoded.partition(':')
        return hmac.compare_digest(u.encode(), user.encode()) and hmac.compare_digest(p.encode(), password.encode())
    except Exception:
        return False


def check_gateway(header, settings=None):
    settings = configuration() if settings is None else settings
    key = settings.get('PANEL_GATEWAY_KEY', '')
    return bool(key and header and hmac.compare_digest(str(header), key))


class Handler(CatalogSyncHandlerMixin, SimpleHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(65)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, obj, code=200):
        payload = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _auth(self):
        try:
            settings = configuration()
            if self.server.server_address[0] not in ('127.0.0.1', 'localhost', '::1') and not (settings.get('PANEL_USER') and settings.get('PANEL_PASS')):
                self._json({'error': '对外服务的访问配置缺失，请在服务端修复。'}, 503)
                return False
            if check_gateway(self.headers.get('X-Project-Gateway-Key'), settings):
                return True
            if check_auth(self.headers.get('Authorization'), settings):
                return True
        except ValueError:
            self._json({'error': '私有配置格式不正确，请在本机修正.env.local。'}, 503)
            return False
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Cost Panel"')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return False

    def _public(self):
        name = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip('/') or 'index.html'
        if name not in PUBLIC:
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == '/api/catalog/sync/status':
            return CatalogSyncHandlerMixin.do_GET(self)
        if not self._auth():
            return
        if urllib.parse.urlsplit(self.path).path == '/api/advisor/status':
            return self._json({'configured': configured(), 'adapter': 'openai-compatible', 'online_research': False,
                               'jev': jev_service.status()})
        if self._public():
            super().do_GET()

    def do_HEAD(self):
        if self._auth() and self._public():
            super().do_HEAD()

    def do_POST(self):
        if self.path == '/api/catalog/sync':
            return CatalogSyncHandlerMixin.do_POST(self)
        if not self._auth():
            return
        if self.path not in ('/api/advisor/analyze', '/api/advisor/review', '/api/advisor/interpret'):
            return self._json({'error': '接口不存在'}, 404)
        origin = self.headers.get('Origin')
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get('Host'):
            return self._json({'error': '仅允许当前站点发起请求'}, 403)
        if self.headers.get_content_type() != 'application/json':
            return self._json({'error': '请使用 application/json'}, 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 200_000:
                return self._json({'error': '请求过大或为空'}, 413)
            body = json.loads(self.rfile.read(length).decode('utf-8'), parse_constant=lambda _: None)
        except (ValueError, UnicodeError):
            return self._json({'error': '请求体必须是有效 JSON'}, 400)
        if not SLOTS.acquire(blocking=False):
            return self._json({'error': '问答正在处理较多请求，请稍后重试'}, 429)
        try:
            if self.path == '/api/advisor/interpret':
                self._json({'interpretation': jev_intake.interpret(body)})
            elif self.path == '/api/advisor/review':
                self._json({'review': jev_service.review(body)})
            else:
                result, error, code = analyze(body)
                self._json({'error': error} if error else result, code)
        except ValueError as error:
            self._json({'error': str(error)}, 400)
        finally:
            SLOTS.release()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    try:
        settings = configuration(ROOT)
    except ValueError as error:
        parser.error(str(error))
    if args.host not in ('127.0.0.1', 'localhost', '::1') and not (settings.get('PANEL_USER') and settings.get('PANEL_PASS')):
        parser.error('对外监听前必须配置 PANEL_USER/PANEL_PASS；建议本机监听配合 HTTPS 反向代理。')
    print('Cost Panel v5.0: %s:%d; advisor=%s' % (args.host, args.port, 'configured' if configured() else 'not configured'))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
