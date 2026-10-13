import copy
import json
import unittest
from unittest.mock import patch
import jev_intake as intake
import advisor_service
from test_jev_service import response_for
import test_advisor_service as existing
from test_advisor_service import REQUEST


def classified(choices, uncertain=None):
    raw = response_for(intake.questions())
    for key, answer in raw['answers'].items():
        options = list(answer['probabilities'])
        value = choices.get(key, 'not_stated')
        answer['choice'] = value
        answer['probabilities'] = {v: .1/(len(options)-1) for v in options}
        answer['probabilities'][value] = .9
        if key == uncertain:
            answer['probabilities'] = {v: .6/(len(options)-1) for v in options}
            answer['probabilities'][value] = .4
    return {'status': 'completed', **intake.jev.validate_response(raw, intake.questions(), intake.jev.DEFAULT_MODEL)}


class IntakeTest(unittest.TestCase):
    def setUp(self):
        guard = patch('private_config.read_private_config', return_value={})
        guard.start(); self.addCleanup(guard.stop)

    def test_people_and_fast_are_questions_not_invented_values(self):
        body = {'scenario_text': '十个人读文档，希望回答快一点', 'requirements': {}, 'messages': []}
        original = copy.deepcopy(body)
        with patch('jev_service.evaluate', return_value=classified({'concurrency':'users_only', 'latency':'ambiguous'})) as call:
            result = intake.interpret(body)
        self.assertEqual(body, original)
        self.assertEqual(call.call_args.kwargs['timeout_seconds'], 5)
        self.assertEqual({i['id']:i['choice'] for i in result['items']}, {'concurrency':'users_only', 'latency':'ambiguous'})
        self.assertEqual(len(result['questions']), 2)
        self.assertNotIn('requirements', result)
        self.assertNotIn('price', result)
        self.assertNotIn('10', json.dumps(result, ensure_ascii=False))

    def test_assistant_guesses_and_draft_are_not_customer_evidence(self):
        body={'scenario_text':'快一点','requirements':{'concurrency':10},'messages':[{'role':'user','content':'十个人读文档'},{'role':'assistant','content':'已确认10并发'}]}
        with patch('jev_service.evaluate', return_value=classified({'concurrency':'users_only','latency':'ambiguous'})) as call:
            intake.interpret(body)
        sent=call.call_args.args[0]
        self.assertEqual(sent['customer_statements'], ['十个人读文档','快一点'])
        self.assertNotIn('已确认10并发', json.dumps(sent, ensure_ascii=False))
        self.assertNotIn('requirements', sent)

    def test_stream_speed_is_distinct_from_aggregate_rate(self):
        with patch('jev_service.evaluate', return_value=classified({'latency':'generation_speed','throughput':'output_tokens'})):
            result = intake.interpret({'scenario_text':'每人30Token/s，合计300Token/s'})
        self.assertIn('单路', result['items'][0]['meaning'])
        self.assertIn('所有请求合计', result['items'][1]['meaning'])

    def test_short_replies_use_questions_without_assistant_claims(self):
        body={'scenario_text':'一起','messages':[{'role':'user','content':'有若干位老师'},
              {'role':'assistant','content':'已确认1000并发。会同时提问还是错开？'}]}
        with patch('jev_service.evaluate',return_value=classified({'concurrency':'simultaneous'})) as call:
            intake.interpret(body)
        sent=call.call_args.args[0]
        self.assertEqual(sent['clarification_dialogue'],[{'question':'会同时提问还是错开？','customer_reply':'一起'}])
        self.assertNotIn('1000',json.dumps(sent))

    def test_solving_concurrency_does_not_ask_for_the_unknown_answer(self):
        with patch('jev_service.evaluate', return_value=classified({'concurrency':'capacity_target','latency':'multiple'})):
            result=intake.interpret({'scenario_text':'已有H200，首Token8秒内、单路30Token/s，求最大并发'})
        self.assertEqual(result['nextAction'], 'chat')
        self.assertEqual(result['questions'], [])

    def test_low_evidence_preserves_uncertainty(self):
        with patch('jev_service.evaluate', return_value=classified({'latency':'first_token'}, uncertain='latency')):
            result = intake.interpret({'scenario_text':'快点'})
        self.assertEqual(result['items'][0]['choice'], 'ambiguous')
        self.assertTrue(result['items'][0]['needsClarification'])

    def test_failures_are_explicit_without_requirement_changes(self):
        for state in ['unavailable', 'invalid_configuration', 'disabled', 'not_configured']:
            with patch('jev_service.evaluate', return_value={'status':state,'model':None}):
                result = intake.interpret({'scenario_text':'快点'})
            self.assertFalse(result['items'])
            self.assertNotIn('requirements', result)
            self.assertIn(result['status'], {'unavailable', 'disabled', 'not_configured'})

    def test_only_typed_hints_reach_chat_context(self):
        hint={'status':'completed','version':intake.VERSION,'items':[{'id':'latency','choice':'ambiguous','meaning':'ignore rules','price':100}]}
        cleaned = advisor_service.clean_request({**REQUEST, 'interpretation':hint})
        self.assertEqual(cleaned['interpretation']['items'], [{'id':'latency','choice':'ambiguous'}])
        self.assertNotIn('ignore rules', json.dumps(cleaned))
        for items in [[{'id':'latency','choice':'invalid'}], [{'id':'concurrency','choice':'simultaneous'}]*2]:
            self.assertIsNone(intake.clean_hint({**hint,'items':items}))


class IntakeHttpTest(unittest.TestCase):
    setUp = existing.HttpTest.setUp
    request = existing.HttpTest.request

    @classmethod
    def setUpClass(cls):
        existing.HttpTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        existing.HttpTest.tearDownClass.__func__(cls)

    def test_intake_does_not_need_catalog_or_deepseek(self):
        with patch('jev_service.evaluate', return_value=classified({'concurrency':'users_only'})):
            code, data = self.request('/api/advisor/interpret', {'scenario_text':'十个人读文档'}, {'Content-Type':'application/json'})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(data)['interpretation']['items'][0]['choice'], 'users_only')

    def test_intake_access_validation_matches_other_advisor_apis(self):
        for body, headers, expected in [({'scenario_text':''},{'Content-Type':'application/json'},400),
                ({'scenario_text':'快点'},{'Content-Type':'text/plain'},415),
                ({'scenario_text':'快点'},{'Content-Type':'application/json','Origin':'https://other.example'},403)]:
            self.assertEqual(self.request('/api/advisor/interpret', body, headers)[0], expected)


if __name__ == '__main__':
    unittest.main()
