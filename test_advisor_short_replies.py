"""Regression for the screenshot: precision-only replies must not lose the scenario."""
import copy
import json
from pathlib import Path
import subprocess
import unittest
import advisor_service as service
from test_advisor_service import REQUEST


class ShortReplyTest(unittest.TestCase):
    def request(self, text='8', **patches):
        known = dict(model='m', card='c', concurrency=20, speed=40, inputK=128, outputK=1, ttft=30)
        return service.clean_request({**REQUEST, 'scenario_text': text, 'requirements': known,
                                      'hard_constraints': [], **patches})

    def answer(self, request, **patches):
        return service.clean_response({'assistant_message': '还有哪些需求需要补充？', 'requirements': {}, **patches}, request)

    def test_bare_bit_width_cannot_become_a_guessed_precision(self):
        for text, extracted in [('8', '8'), ('8', 8), ('8位', 'fp8'), ('8bit', 'int8'), ('16', 'bf16'), ('4', 'int4')]:
            with self.subTest(text=text, extracted=extracted):
                request = self.request(text)
                out = self.answer(request, requirements={'precision': extracted}, hard_constraints=['precision'],
                                  flexible_fields=['precision'], flexible_evidence={'precision': text}, suggested_requirements={'precision': 'int8'})
                self.assertEqual(out['requirements'], request['requirements'])
                self.assertNotIn('precision', out['hard_constraints'])
                self.assertNotIn('precision', out['suggested_requirements'])
                self.assertEqual(out['flow']['next_fields'], ['precision'])
                self.assertFalse(out['flow']['ready'])
                self.assertIn('还是', out['questions'][0])
                self.assertNotIn('并发', out['questions'][0])

    def test_nothing_else_preserves_precision_ambiguity_and_known_requirements(self):
        request = self.request('没了', messages=[{'role': 'assistant', 'content': '模型精度有要求吗？'},
                                                {'role': 'user', 'content': '8'},
                                                {'role': 'assistant', 'content': '还有哪些需求需要补充？'}])
        out = self.answer(request, requirements={'precision': 'fp8'})
        self.assertEqual(out['requirements'], request['requirements'])
        self.assertEqual(out['flow']['next_fields'], ['precision'])
        self.assertIn('INT8', out['questions'][0]); self.assertIn('FP8', out['questions'][0])

    def test_explicit_format_completes_the_scenario_even_if_upstream_omits_it(self):
        for text in ['INT8', 'int8。', 'FP8']:
            request = self.request(text)
            out = self.answer(request)
            self.assertEqual(out['requirements'], {**request['requirements'], 'precision': text.lower().rstrip('。')})
            self.assertTrue(out['flow']['ready'])
            self.assertEqual(out['questions'], [])

    def test_empty_reply_does_not_erase_a_confirmed_precision(self):
        request = self.request('没了', requirements={**self.request()['requirements'], 'precision': 'int8'})
        out = self.answer(request, requirements={'precision': None})
        self.assertEqual(out['requirements'], request['requirements'])
        self.assertTrue(out['flow']['ready'])

    def test_eight_is_still_concurrency_when_that_is_the_missing_field(self):
        known = {**self.request()['requirements'], 'precision': 'int8'}
        del known['concurrency']
        out = self.answer(self.request(requirements=known), requirements={'concurrency': 8})
        self.assertEqual(out['requirements']['concurrency'], 8)
        self.assertEqual(out['requirements']['precision'], 'int8')
        self.assertTrue(out['flow']['ready'])

    def test_same_policy_with_another_chip_and_reverse_goal(self):
        known = {**self.request()['requirements'], 'mode': 'reverse', 'reverseTarget': 'concurrency', 'servers': 1, 'slots': 8}
        del known['concurrency']
        catalog = copy.deepcopy(REQUEST['catalog'])
        catalog['cards'] = [{'id': 'other'}]
        catalog['paths'] = [{'model': 'm', 'card': 'other', 'precisions': ['fp8']}]
        known['card'] = 'other'
        request = self.request(requirements=known, catalog=catalog)
        out = self.answer(request, requirements={'precision': 'fp8'})
        self.assertEqual(out['flow']['next_fields'], ['precision'])
        self.assertEqual(out['requirements'], request['requirements'])

    def test_invalid_values_are_missing_on_both_sides(self):
        for key, value in [('precision', '8'), ('model', 'not-in-catalog'), ('card', 'not-in-catalog'),
                           ('concurrency', 1.5), ('speed', -1), ('ttft', 50000), ('inputK', 50000)]:
            known = {**self.request()['requirements'], 'precision': 'int8'}
            del known[key]
            request = self.request('确认', requirements=known)
            out = self.answer(request, requirements={key: value})
            self.assertNotIn(key, out['requirements'])
            self.assertIn(key, out['flow']['next_fields'])
            self.assertFalse(out['flow']['ready'])

    def test_backend_ranges_choices_and_precision_names_match_calculator(self):
        root = Path(__file__).parent
        script = "const C=require('./advisor-core.js'),E=require('./engine-v5.js');process.stdout.write(JSON.stringify({numeric:C.numeric,choices:C.choices,precisions:Object.keys(E.precision)}))"
        front = json.loads(subprocess.check_output(['node', '-e', script], cwd=root, text=True))
        rules = service.advisor_flow.SCHEMA['validation']
        for key in ['numeric', 'choices']:
            self.assertEqual(rules[key], front[key])
        self.assertEqual(set(rules['precisions']), set(front['precisions']))


if __name__ == '__main__':
    unittest.main()
