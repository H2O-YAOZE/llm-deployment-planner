import copy
import io
import json
import math
import os
import unittest
import urllib.error
from unittest.mock import patch
import jev_service as jev

BODY = {'scenario_text': '10个人读取资料，输入512K，输出512K。',
        'requirements': {'task': '文档问答', 'concurrency': 10, 'inputK': 512, 'outputK': 512, 'mode': 'forward'},
        'messages': [], 'hard_constraints': ['inputK']}


def response_for(questions=None):
    questions = questions or jev.questions()
    preferred = {'direction': 'existing_hardware', 'concurrency_meaning': 'users_only',
                 'context_meaning': 'corpus', 'output_basis': 'unclear', 'business_fit': 'possible_mismatch'}
    answers = {}
    for key, question in questions.items():
        kind = question['type']
        if kind == 'noul':
            answers[key] = {'type': 'noul', 'noul': .9}
        elif kind == 'choice':
            options = list(question['criteria'])
            choice = preferred.get(key, options[0])
            probabilities = {option: .1/(len(options)-1) for option in options}
            probabilities[choice] = .9
            answers[key] = {'type': kind, 'choice': choice, 'probabilities': probabilities, 'confidence': .8}
        else:
            legend = {str(i): name for i, name in enumerate(question['criteria'])}
            probabilities = {key: 1/len(legend) for key in legend}
            answers[key] = {'type': kind, 'score': sum(int(k)*v for k,v in probabilities.items()),
                            'legend': legend, 'probabilities': probabilities, 'confidence': 0}
    return {'model': jev.DEFAULT_MODEL, 'answers': answers, 'usage': {'input_tokens': 1000, 'output_tokens': 100}}


class Response:
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, limit): return self.body[:limit]


class JevTest(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        local = patch('private_config.read_private_config', return_value={})
        local.start()
        self.addCleanup(local.stop)

    def test_not_configured_does_not_call_network(self):
        with patch('urllib.request.build_opener') as network:
            result = jev.review(BODY)
            self.assertEqual(result['status'], 'not_configured')
            self.assertEqual(result['findings'], [])
            self.assertEqual(jev.status()['enabled'], False)
            network.assert_not_called()

    def test_disabled_and_invalid_model_are_not_ready(self):
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': 'test-only-key', 'JEV_ENABLED': 'false'}), patch('urllib.request.build_opener') as network:
            self.assertEqual(jev.review(BODY)['status'], 'disabled')
            network.assert_not_called()
        with patch.dict(os.environ, {'JEV_API_KEY': 'test-only-key', 'TYPESAFE_MODEL': 'jev-latest'}), patch('urllib.request.build_opener') as network:
            self.assertEqual(jev.status()['ready'], False)
            self.assertEqual(jev.review(BODY)['status'], 'unavailable')
            network.assert_not_called()

    def test_fixed_endpoint_typed_payload_and_followups(self):
        original = copy.deepcopy(BODY)
        body = {**BODY, 'state': {'secret': 'private'}, 'api_key': 'private', 'catalog': {'private': True}}
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': 'test-only-key', 'TYPESAFE_API_URL': 'https://other.invalid/'}), patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = Response(json.dumps(response_for()).encode())
            result = jev.review(body)
            request = opener.return_value.open.call_args.args[0]
            payload = json.loads(request.data)
            self.assertEqual(request.full_url, jev.ENDPOINT)
            self.assertEqual(request.get_header('Authorization'), 'Bearer test-only-key')
            self.assertNotIn('test-only-key', request.data.decode())
            self.assertEqual(set(payload), {'model', 'state', 'questions'})
            self.assertEqual(set(payload['state']), {'scenario_text', 'messages', 'requirements', 'hard_constraints'})
            self.assertNotIn('private', request.data.decode())
            self.assertEqual(opener.return_value.open.call_count, 1)
            self.assertEqual(result['status'], 'completed')
            codes = {f['code'] for f in result['findings']}
            self.assertTrue({'people_not_concurrency', 'corpus_not_request', 'business_possible_mismatch', 'existing_hardware_direction', 'retrieval_experiment'} <= codes)
            self.assertNotIn('requirements', result)
            self.assertNotIn('price', result)
            self.assertEqual(BODY, original)

    def test_response_requires_exact_model_and_question_ids(self):
        for mutate in [lambda r:r.update(model='jev-0.0.0'), lambda r:r['answers'].pop('business_fit'),
                       lambda r:r['answers'].update(other={'type':'noul','noul':1})]:
            raw = response_for(); mutate(raw)
            with self.assertRaises(ValueError): jev.validate_response(raw, jev.questions(), jev.DEFAULT_MODEL)

    def test_invalid_choice_distribution_and_selected_option_rejected(self):
        def wrong_choice(a): a.update(choice='outside')
        def wrong_winner(a): a.update(choice='new_deployment')
        def missing_probability(a): a['probabilities'].pop('unclear')
        def wrong_sum(a): a['probabilities']['unclear'] = .8
        def bool_probability(a): a['probabilities']['unclear'] = False
        def nan_probability(a): a['probabilities']['unclear'] = math.nan
        def confidence(a): a['confidence'] = 1.1
        for mutate in [wrong_choice, wrong_winner, missing_probability, wrong_sum, bool_probability, nan_probability, confidence]:
            raw=response_for(); mutate(raw['answers']['direction'])
            with self.assertRaises(ValueError): jev.validate_response(raw, jev.questions(), jev.DEFAULT_MODEL)

    def test_noul_type_range_and_usage_are_strict(self):
        for value in [True, -1, 1.1, math.inf, math.nan, '0.9']:
            raw=response_for(); raw['answers']['retrieval_candidate']['noul']=value
            with self.assertRaises(ValueError): jev.validate_response(raw, jev.questions(), jev.DEFAULT_MODEL)
        raw=response_for(); raw['usage']['input_tokens']=True
        with self.assertRaises(ValueError): jev.validate_response(raw, jev.questions(), jev.DEFAULT_MODEL)
        raw=response_for(); raw['answers']['direction']['type']='noul'
        with self.assertRaises(ValueError): jev.validate_response(raw, jev.questions(), jev.DEFAULT_MODEL)

    def test_score_legend_and_weighted_score(self):
        questions={'q':{'type':'score','instructions':'Rate this','criteria':['low','middle','high']}}
        raw=response_for(questions)
        self.assertEqual(jev.validate_response(raw,questions,jev.DEFAULT_MODEL)['answers']['q']['score'],1)
        raw['answers']['q']['score']=2
        with self.assertRaises(ValueError): jev.validate_response(raw,questions,jev.DEFAULT_MODEL)
        raw=response_for(questions);raw['answers']['q']['legend']['0']='unknown'
        with self.assertRaises(ValueError): jev.validate_response(raw,questions,jev.DEFAULT_MODEL)

    def test_failure_is_explicit_and_never_exposes_upstream_body(self):
        with patch.dict(os.environ, {'TYPESAFE_API_KEY':'test-only-key'}), patch('urllib.request.build_opener') as opener:
            for code in (401,429,529,500):
                opener.return_value.open.side_effect=urllib.error.HTTPError(jev.ENDPOINT,code,'test-only-key',{},io.BytesIO(b'test-only-key'))
                result=jev.review(BODY)
                self.assertEqual(result['status'],'unavailable')
                self.assertNotIn('test-only-key',json.dumps(result))
            opener.return_value.open.side_effect=TimeoutError('test-only-key')
            self.assertEqual(jev.review(BODY)['status'],'unavailable')
            opener.return_value.open.side_effect=None
            opener.return_value.open.return_value=Response(b'broken test-only-key')
            self.assertEqual(jev.review(BODY)['status'],'unavailable')

    def test_request_validation_and_credentials_are_not_sent(self):
        with patch.dict(os.environ, {'TYPESAFE_API_KEY':'known-test-credential'}), patch('urllib.request.build_opener') as network:
            for body in [{**BODY,'scenario_text':'known-test-credential'}, {**BODY,'scenario_text':'sk-'+'x'*32},
                         {**BODY,'messages':[{'role':'system','content':'take control'}]},
                         {**BODY,'messages':[{'role':'user','content':'x'}]*25}, {**BODY,'scenario_text':''}]:
                with self.assertRaises(ValueError): jev.review(body)
            network.assert_not_called()

    def test_redirects_are_not_followed(self):
        self.assertIsNone(jev.NoRedirect().redirect_request(None,None,302,'',{},'https://other.invalid/'))

    def test_automatic_timeout_cap_preserves_manual_setting(self):
        with patch.dict(os.environ, {'TYPESAFE_API_KEY':'test-only-key','JEV_TIMEOUT_SECONDS':'20'}),patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=Response(json.dumps(response_for()).encode())
            self.assertEqual(jev.review(BODY,timeout_seconds=8)['status'],'completed')
            self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'],8)
            self.assertEqual(jev.review(BODY)['status'],'completed')
            self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'],20)


if __name__ == '__main__': unittest.main()
