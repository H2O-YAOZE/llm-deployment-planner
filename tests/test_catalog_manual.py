import io,json,sys,unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,catalog_sync_service as service

class ManualTests(unittest.TestCase):
    def handler(self,path):
        h=server.Handler.__new__(server.Handler);h.path=path;h.headers=Message()
        h._auth=lambda:True;h.replies=[];h._json=lambda obj,code=200:h.replies.append((code,obj))
        h.headers['Host']='127.0.0.1:8095';return h
    def test_get_actual_handler_dispatches_manual_route(self):
        h=self.handler('/api/catalog/sync/status')
        with patch.object(service,'status',return_value={'job':{'state':'idle'}}):h.do_GET()
        self.assertEqual(h.replies,[(200,{'job':{'state':'idle'}})])
    def test_post_starts_only_fixed_window(self):
        h=self.handler('/api/catalog/sync');data=b'{"days":60}'
        h.headers['Content-Type']='application/json';h.headers['Content-Length']=str(len(data));h.rfile=io.BytesIO(data)
        with patch.object(service,'start',return_value=({'state':'running'},True)) as start:h.do_POST();start.assert_called_once_with(60)
        self.assertEqual(h.replies[0][0],202)
    def test_unauthenticated_and_cross_origin_do_not_start_jobs(self):
        h=self.handler('/api/catalog/sync');h._auth=lambda:False
        with patch.object(service,'start') as start:h.do_POST();start.assert_not_called()
        h=self.handler('/api/catalog/sync');h.headers['Origin']='https://other.test'
        with patch.object(service,'start') as start:h.do_POST();start.assert_not_called()
        self.assertEqual(h.replies[0][0],403)
    def test_script_paths_cannot_be_submitted(self):
        h=self.handler('/api/catalog/sync');data=b'{"days":60,"command":"bad"}'
        h.headers['Content-Type']='application/json';h.headers['Content-Length']=str(len(data));h.rfile=io.BytesIO(data)
        with patch.object(service,'start') as start:h.do_POST();start.assert_not_called()
        self.assertEqual(h.replies[0][0],400)
    def test_private_config_and_state_are_not_served(self):
        for name in ['.env.catalog-sync','sync-state/latest.json','catalog_sync_service.py','scripts/catalog_sync.py']:
            self.assertNotIn(name,server.PUBLIC)
        self.assertIn('catalog-sync-ui.js',server.PUBLIC)

if __name__=='__main__':unittest.main()
