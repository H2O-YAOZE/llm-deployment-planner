"""Authenticated manual sync jobs. Fetching runs off the request thread."""
import datetime as dt
import importlib.util
import json
import threading
import urllib.parse
from pathlib import Path

_guard=threading.Lock()
_job={'state':'idle'}
ROOT=Path(__file__).resolve().parent

def status():
    with _guard:job=dict(_job)
    path=ROOT/'sync-state/latest.json'
    report=json.loads(path.read_bytes()) if path.exists() else {}
    return {'job':job,'summary':{k:report.get(k) for k in ('status','lastAttemptAt','lastUpdatedAt','coverage')},
        'changes':{k:len(v) for k,v in report.get('changes',{}).items()},'pending':len(report.get('pending',[]))}

def start(days):
    global _job
    if isinstance(days,bool) or days!=60:raise ValueError('扫描范围固定为最近60天')
    with _guard:
        if _job.get('state')=='running':return dict(_job),False
        previous=_job.get('startedAt')
        if previous and dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(previous)<dt.timedelta(minutes=2):
            raise ValueError('刚完成一次扫描，请两分钟后再试')
        _job={'state':'running','startedAt':dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),'days':60}
    def work():
        global _job
        try:
            spec=importlib.util.spec_from_file_location('manual_catalog_sync',ROOT/'scripts/catalog_sync.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            result=module.run(ROOT,use_llm=True,scan_days=60)
            with _guard:_job={**_job,'state':'done','result':result}
        except Exception as e:
            with _guard:_job={**_job,'state':'failed','error':type(e).__name__}
    threading.Thread(target=work,name='catalog-manual-sync',daemon=True).start()
    return dict(_job),True

class CatalogSyncHandlerMixin:
    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path=='/api/catalog/sync/status':
            if self._auth():self._json(status())
            return
        return super().do_GET()
    def do_POST(self):
        if self.path!='/api/catalog/sync':return super().do_POST()
        if not self._auth():return
        origin=self.headers.get('Origin')
        if origin and urllib.parse.urlsplit(origin).netloc!=self.headers.get('Host'):
            return self._json({'error':'仅允许当前站点发起请求'},403)
        if self.headers.get_content_type()!='application/json':return self._json({'error':'请使用application/json'},415)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=2048:return self._json({'error':'请求大小无效'},413)
            body=json.loads(self.rfile.read(size).decode('utf-8'))
            if not isinstance(body,dict) or set(body)!={'days'}:raise ValueError('只接受最近60天扫描')
            job,started=start(body['days']);return self._json({'job':job},202 if started else 200)
        except (ValueError,UnicodeError) as e:return self._json({'error':str(e)},400)
