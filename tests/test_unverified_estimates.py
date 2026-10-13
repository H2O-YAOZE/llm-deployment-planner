import copy
import unittest
import advisor_service as service
from test_advisor_service import REQUEST


class EstimateFlowTest(unittest.TestCase):
    def test_warning_does_not_block_or_replace_customer_hardware(self):
        raw = copy.deepcopy(REQUEST)
        raw['catalog']['models'][0].update(local=True, estimationNote='架构替代参考，误差可能较大')
        raw['catalog']['paths'][0]['estimationNote'] = '此模型在此硬件上的适配未核实，仅作估算，误差可能较大'
        requirements = dict(model='m', card='c', precision='int8', concurrency=20,
                            speed=30, inputK=1, outputK=1, ttft=30)
        request = service.clean_request(raw)
        reply = service.clean_response({'assistant_message': '已记下', 'requirements': requirements}, request)
        self.assertTrue(reply['flow']['ready'])
        self.assertEqual(reply['requirements']['card'], 'c')
        self.assertTrue(any('误差可能较大' in n for n in reply['warnings']))
        requirements.pop('precision')
        reply = service.clean_response({'assistant_message': '已记下', 'requirements': requirements}, request)
        self.assertFalse(reply['flow']['ready'])
        self.assertIn('仅作估算', reply['flow']['question'])
        self.assertNotEqual(reply['flow']['next_field'], 'model')
