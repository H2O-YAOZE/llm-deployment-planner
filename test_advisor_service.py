import copy
import base64
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import advisor_service as service
import server

REQUEST = {'scenario_text': '20 并发，输入128K，上下文1M，多模态', 'messages': [], 'requirements': {'concurrency': 20},
           'hard_constraints': ['concurrency'], 'catalog': {'models': [{'id': 'm', 'name': '模型'}],
           'cards': [{'id': 'c'}], 'paths': [{'model': 'm', 'card': 'c', 'precisions': ['int8']}]}}


class AdapterTest(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict(os.environ, {}, clear=True), patch('private_config.read_private_config', return_value={})):
            guard.start()
            self.addCleanup(guard.stop)

    def test_jev_failure_does_not_mutate_conversation_or_requirements(self):
        answer={'assistant_message':'请核对','requirements':{'concurrency':20},'hard_constraints':['concurrency'],'questions':[], 'recommendations':[]}
        original=copy.deepcopy(answer)
        with patch('jev_service.review',side_effect=RuntimeError('upstream failure')):
            result=service.attach_semantic_review(answer,service.clean_request(REQUEST))
        self.assertEqual(result['review']['status'],'unavailable')
        self.assertEqual({k:v for k,v in result.items() if k!='review'},original)

    def test_auto_review_can_be_disabled_without_disabling_manual_review(self):
        answer={'assistant_message':'请核对','requirements':{},'hard_constraints':[]}
        with patch.dict(os.environ,{'TYPESAFE_API_KEY':'test-only-key','JEV_AUTO_REVIEW':'false'}),patch('jev_service.review') as review:
            result=service.attach_semantic_review(answer,service.clean_request(REQUEST))
            self.assertEqual(result['review']['status'],'disabled');review.assert_not_called()
            self.assertEqual(service.jev_service.status()['ready'],True)
    def test_reverse_fields_preserved(self):
        raw={'mode':'reverse','reverseTarget':'throughput','servers':2,'slots':8,'throughput':0,'throughputMetric':'sustained-output','contextMode':'native','topologyMode':'replicas','multiNode':False,'usageHours':12,'requestsPerDay':1000}
        self.assertEqual(service.clean_requirements(raw),raw)

    def test_output_limit_is_explicit_and_preserved(self):
        raw={'mode':'reverse','reverseTarget':'output','responseSlo':150,'servers':1,'slots':8}
        self.assertEqual(service.clean_requirements(raw),raw)
        self.assertNotIn('responseSlo',service.clean_requirements({'mode':'reverse','reverseTarget':'output'}))

    def test_unsupported_requirements_are_not_silently_dropped(self):
        raw={'assistant_message':'这些要求暂不能核验', 'requirements':{'throughput':500,'throughputMetric':'requests','contextMode':'extended','reverseTarget':'throughput'}}
        clean=service.clean_response(raw,service.clean_request(REQUEST))
        self.assertEqual(clean['requirements'],{**REQUEST['requirements'],**raw['requirements']})

    def test_current_catalog_fits_allowlist(self):
        from pathlib import Path
        d=json.loads((Path(__file__).parent/'catalog.json').read_text('utf-8'))
        catalog={'models':[{'id':m['id'],'name':m['name'],'local':not m['catalogOnly']} for m in d['models'].values()], 'cards':[{'id':c['id']} for c in d['cards'].values()], 'paths':[]}
        self.assertEqual(len(service.clean_catalog(catalog)['models']),len(d['models']))

    def test_allowlist(self):
        r = copy.deepcopy(REQUEST)
        r.update(api_key='do-not-send', files=['private'], state={'price': 0})
        r['requirements'].update(apiMiss=0, secret='private')
        r['catalog']['models'][0]['secret'] = 'private'
        clean = service.clean_request(r)
        self.assertNotIn('private', json.dumps(clean))
        self.assertNotIn('api_key', clean)

    def test_roles_and_length(self):
        for messages in [[{'role': 'system', 'content': 'bad'}], [{'role': 'user', 'content': 'x'}]*25]:
            with self.assertRaises(ValueError):
                service.clean_request({**REQUEST, 'messages': messages})

    def test_secret_block(self):
        with self.assertRaises(ValueError):
            service.clean_request({**REQUEST, 'scenario_text': 'sk-'+'x'*32})

    def test_response_filters(self):
        raw = {'assistant_message': '核对需求', 'requirements': {'concurrency': 1}, 'hard_constraints': [],
               'cards': 999, 'price': 0, 'recommendations': [{'model': 'm', 'card': 'c', 'precision': 'fp8'}]}
        out = service.clean_response(raw, service.clean_request(REQUEST))
        self.assertEqual(out['requirements']['concurrency'], 20)
        self.assertNotIn('cards', out)
        self.assertEqual(out['recommendations'], [])
        self.assertIn('concurrency', out['hard_constraints'])
        self.assertTrue(out['unresolved'])
        self.assertEqual(out['pending_changes'], [{'field':'concurrency','from':20,'to':1}])

    def test_field_flow_does_not_reopen_known_metrics_at_any_value(self):
        for concurrency,speed in [(7,18),(50,30),(900,75)]:
            req={'concurrency':concurrency,'speed':speed,'model':'m','card':'c','precision':'int8'}
            request=service.clean_request({**REQUEST,'requirements':req,'hard_constraints':[]})
            raw={'assistant_message':'任意错误重复追问？','requirements':{},'questions':['旧追问？'],
                 'unresolved':['旧追问？'],'clarifications':[{'field':'concurrency','question':'重新问并发？'}]}
            out=service.clean_response(raw,request)
            self.assertEqual(out['requirements'],req)
            self.assertEqual(out['flow']['next_field'],'inputK')
            self.assertEqual(len(out['questions']),1)
            self.assertNotIn('并发',out['questions'][0])
            self.assertEqual(out['unresolved'],[])

    def test_independent_aggregate_constraints_remain_intact(self):
        request=service.clean_request({**REQUEST,'hard_constraints':[]})
        out=service.clean_response({'assistant_message':'','requirements':{'speed':73,'throughput':2460,'throughputMetric':'sustained-output'}},request)
        self.assertEqual(out['requirements']['throughput'],2460)

    def test_typed_missing_field_clarification_is_preserved(self):
        request=service.clean_request({**REQUEST,'hard_constraints':[]})
        out=service.clean_response({'assistant_message':'','requirements':{},
            'clarifications':[{'field':'speed','question':'你希望的是文字生成快，还是整段回答更早完成？'}]},request)
        self.assertIn('speed',out['flow']['next_fields'])
        self.assertIn('model',out['flow']['next_fields'])
        self.assertEqual(len(out['questions']),1)
        self.assertIn('你希望的是文字生成快，还是整段回答更早完成？',out['questions'][0])

    def test_missing_configuration_no_network(self):
        with patch.dict(os.environ, {}, clear=True), patch('urllib.request.build_opener') as network:
            self.assertEqual(service.analyze(REQUEST)[2], 503)
            network.assert_not_called()

    def test_https_only(self):
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'dummy', 'DEEPSEEK_MODEL': 'test', 'DEEPSEEK_API_URL': 'http://invalid/'}):
            self.assertEqual(service.analyze(REQUEST)[2], 503)

    def test_adapter_payload_and_mock_response(self):
        raw = {'choices': [{'message': {'content': json.dumps({'assistant_message': '继续追问', 'requirements': {'concurrency': 20}, 'questions': ['首字多久？']})}}]}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return json.dumps(raw).encode()
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'dummy-test-only', 'DEEPSEEK_MODEL': 'provider-flash-id'}), patch('urllib.request.build_opener') as opener, patch('advisor_service.attach_semantic_review') as review:
            opener.return_value.open.return_value = Response()
            result, error, code = service.analyze(REQUEST)
            self.assertEqual(code, 200)
            review.assert_not_called()
            sent = json.loads(opener.return_value.open.call_args.args[0].data)
            self.assertEqual(sent['model'], 'provider-flash-id')
            self.assertEqual(sent['thinking'], {'type':'disabled'})
            self.assertNotIn('dummy-test-only', json.dumps(sent))
            self.assertEqual(len(result['questions']),1)
            self.assertIn('dialogue_schema',json.loads(sent['messages'][1]['content'].split('：',1)[1]))

    def test_basic_auth_fail_closed(self):
        with patch.dict(os.environ, {'PANEL_USER': 'user', 'PANEL_PASS': ''}):
            self.assertFalse(server.check_auth(None))

    def test_auth_and_gateway_reuse_the_same_request_snapshot(self):
        snapshot={'PANEL_USER':'user','PANEL_PASS':'test-password','PANEL_GATEWAY_KEY':'test-gateway'}
        header='Basic '+base64.b64encode(b'user:test-password').decode()
        with patch('server.configuration',side_effect=AssertionError('must not reread configuration')):
            self.assertTrue(server.check_auth(header,snapshot))
            self.assertTrue(server.check_gateway('test-gateway',snapshot))
            self.assertFalse(server.check_auth(None,snapshot))


class HttpTest(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict(os.environ, {}, clear=True), patch('private_config.read_private_config', return_value={})):
            guard.start()
            self.addCleanup(guard.stop)
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:'+str(cls.http.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def request(self, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base+path, data=data, headers=headers or {})) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_private_files_not_served(self):
        for path in ['/server.py', '/advisor_service.py', '/jev_service.py', '/jev_intake.py', '/private_config.py', '/.env.local', '/.env.example', '/.env', '/backups/test.json', '/%2e%2e/server.py']:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/index.html')[0], 200)

    def test_origin_and_content_type(self):
        self.assertEqual(self.request('/api/advisor/analyze', REQUEST, {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/advisor/analyze', REQUEST, {'Content-Type': 'application/json', 'Origin': 'https://other.example'})[0], 403)

    def test_http_unconfigured(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.request('/api/advisor/analyze', REQUEST, {'Content-Type': 'application/json'})[0], 503)
            self.assertEqual(json.loads(self.request('/api/advisor/status')[1])['configured'], False)

    def test_independent_review_no_deepseek_required_and_no_secret_status(self):
        body={key:value for key,value in REQUEST.items() if key!='catalog'}
        code,data=self.request('/api/advisor/review',body,{'Content-Type':'application/json'})
        self.assertEqual(code,200);self.assertEqual(json.loads(data)['review']['status'],'not_configured')
        state=json.loads(self.request('/api/advisor/status')[1])
        self.assertEqual(state['jev']['configured'],False);self.assertEqual(state['jev']['ready'],False)
        self.assertNotIn('api_key',json.dumps(state).lower())

    def test_review_http_validation_and_access_boundaries(self):
        self.assertEqual(self.request('/api/advisor/review',{'scenario_text':''},{'Content-Type':'application/json'})[0],400)
        self.assertEqual(self.request('/api/advisor/review',REQUEST,{'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.request('/api/advisor/review',REQUEST,{'Content-Type':'application/json','Origin':'https://other.example'})[0],403)

    def test_review_with_only_typesafe_key(self):
        from test_jev_service import response_for
        reviewed={'status':'completed',**service.jev_service.validate_response(response_for(),service.jev_service.questions(),service.jev_service.DEFAULT_MODEL)}
        with patch.dict(os.environ,{'TYPESAFE_API_KEY':'test-only-key'}),patch('jev_service.evaluate',return_value=reviewed) as evaluate:
            state=json.loads(self.request('/api/advisor/status')[1])
            self.assertFalse(state['configured']);self.assertTrue(state['jev']['ready'])
            body={'scenario_text':'十个人读取资料','requirements':{'concurrency':10}}
            code,data=self.request('/api/advisor/review',body,{'Content-Type':'application/json'})
            self.assertEqual(code,200);self.assertEqual(json.loads(data)['review']['status'],'completed')
            self.assertEqual(evaluate.call_count,1)


if __name__ == '__main__':
    unittest.main()
