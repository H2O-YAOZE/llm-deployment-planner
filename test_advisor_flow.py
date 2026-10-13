import copy
import unittest
import advisor_service as service
from test_advisor_service import REQUEST


class FieldFlowTest(unittest.TestCase):
    def reply(self, requirements, **extra):
        request=service.clean_request({**REQUEST,'scenario_text':'没有要求，由你推荐','requirements':{},'hard_constraints':[]})
        if 'flexible_fields' in extra:
            extra['flexible_evidence']={k:'没有要求，由你推荐' for k in extra['flexible_fields']}
        return service.clean_response({'assistant_message':'模型乱问的文字','requirements':requirements,**extra},request)

    def complete(self):
        return dict(model='m',card='c',precision='int8',concurrency=17,speed=61,inputK=12,outputK=3,ttft=4,task='教学问答',modality='text')

    def test_same_policy_for_every_missing_field(self):
        req=self.complete()
        for key in ['model','card','precision','concurrency','speed','inputK','outputK','ttft']:
            partial={k:v for k,v in req.items() if k!=key}
            out=self.reply(partial,clarifications=[{'field':'concurrency','question':'故意问已经确定的并发？'}])
            self.assertEqual(out['flow']['next_field'],key)
            self.assertFalse(out['flow']['ready'])
            self.assertEqual(len(out['questions']),1)

    def test_complete_requirements_advance_to_confirmation(self):
        out=self.reply(self.complete(),questions=['随意重复并发？'])
        self.assertTrue(out['flow']['ready'])
        self.assertEqual(out['questions'],[])

    def test_all_missing_fields_are_asked_together_without_known_fields(self):
        req=self.complete()
        for field in ['precision','inputK','outputK']:
            del req[field]
        out=self.reply(req)
        self.assertEqual(out['flow']['next_fields'],['precision','inputK','outputK'])
        self.assertEqual(len(out['questions']),1)
        for word in ['精度','输入','输出']:
            self.assertIn(word,out['questions'][0])
        for word in ['并发','业务','首Token']:
            self.assertNotIn(word,out['questions'][0])

    def test_business_and_modality_are_optional(self):
        req=self.complete()
        del req['task'];del req['modality']
        out=self.reply(req)
        self.assertTrue(out['flow']['ready'])
        self.assertEqual(out['questions'],[])

    def test_unrestricted_length_is_a_policy_not_a_customer_number(self):
        req=self.complete();del req['inputK']
        out=self.reply(req,flexible_fields=['inputK'],suggested_requirements={'inputK':8})
        self.assertNotIn('inputK',out['requirements'])
        self.assertEqual(out['suggested_requirements'],{'inputK':8})
        self.assertEqual(next(f['status'] for f in out['flow']['fields'] if f['field']=='inputK'),'suggested')
        self.assertTrue(out['flow']['ready'])

    def test_no_preference_is_not_asked_again_without_a_number(self):
        req=self.complete();del req['precision']
        out=self.reply(req,flexible_fields=['precision'])
        self.assertNotIn('精度有要求吗',out['flow']['question'])
        self.assertTrue(out['flow']['ready'])
        self.assertEqual(out['suggested_requirements'],{'precision':'int8'})
        self.assertNotIn('precision',out['requirements'])

    def test_suggestions_require_permission_and_a_verified_path(self):
        out=self.reply(self.complete(),suggested_requirements={'inputK':800,'card':'fake'})
        self.assertEqual(out['suggested_requirements'],{})
        req=self.complete();del req['card']
        out=self.reply(req,flexible_fields=['card'],suggested_requirements={'card':'fake'})
        self.assertEqual(out['suggested_requirements'].get('card'),'c')
        self.assertTrue(out['flow']['ready'])

    def test_reverse_target_is_not_a_missing_requirement(self):
        req=self.complete();req.update(mode='reverse',reverseTarget='concurrency',servers=1,slots=2);del req['concurrency']
        out=self.reply(req)
        self.assertTrue(out['flow']['ready'])
        self.assertNotIn('concurrency',[f['field'] for f in out['flow']['fields']])

    def test_planning_precision_is_not_an_automatic_suggestion(self):
        catalog=copy.deepcopy(REQUEST['catalog'])
        catalog['paths']=[{'model':'m','card':'c','precisions':['int8'],'planningPrecisions':['int8']}]
        request=service.clean_request({**REQUEST,'catalog':catalog,'scenario_text':'没有要求，由你推荐','requirements':{},'hard_constraints':[]})
        self.assertEqual(request['catalog']['paths'][0]['planningPrecisions'],['int8'])
        req=self.complete();del req['precision']
        out=service.clean_response({'assistant_message':'待确认精度','requirements':req,'flexible_fields':['precision'],'flexible_evidence':{'precision':'没有要求，由你推荐'}},request)
        self.assertNotIn('precision',out['suggested_requirements']);self.assertFalse(out['flow']['ready'])
        out=service.clean_response({'assistant_message':'明确INT8，按规划路径确认','requirements':self.complete()},request)
        self.assertTrue(out['flow']['ready']);self.assertEqual(out['requirements']['precision'],'int8')

    def test_planning_path_requires_the_customer_to_specify_all_three_choices(self):
        catalog=copy.deepcopy(REQUEST['catalog'])
        catalog['paths']=[{'model':'m','card':'c','precisions':['int8'],'planningPrecisions':['int8']}]
        request=service.clean_request({**REQUEST,'catalog':catalog,'scenario_text':'没有要求，由你推荐','requirements':{},'hard_constraints':[]})
        for field in ['model','card','precision']:
            req=self.complete();del req[field]
            raw={'assistant_message':'推荐','requirements':req,'flexible_fields':[field],
                 'flexible_evidence':{field:'没有要求，由你推荐'},'suggested_requirements':{field:self.complete()[field]}}
            out=service.clean_response(raw,request)
            self.assertNotIn(field,out['suggested_requirements'])
            self.assertFalse(out['flow']['ready'])
        out=service.clean_response({'assistant_message':'明确全部组合','requirements':self.complete()},request)
        self.assertTrue(out['flow']['ready'])

    def test_known_path_can_still_be_recommended_when_another_path_is_planning_only(self):
        catalog=copy.deepcopy(REQUEST['catalog'])
        catalog['cards'].append({'id':'other','name':'其他芯片','precisions':['int8'],'domestic':False})
        catalog['paths']=[{'model':'m','card':'other','precisions':['int8'],'planningPrecisions':['int8']},
                          {'model':'m','card':'c','precisions':['int8']}]
        request=service.clean_request({**REQUEST,'catalog':catalog,'scenario_text':'没有要求，由你推荐','requirements':{},'hard_constraints':[]})
        req=self.complete();del req['card']
        out=service.clean_response({'assistant_message':'推荐','requirements':req,'flexible_fields':['card'],
                                    'flexible_evidence':{'card':'没有要求，由你推荐'}},request)
        self.assertEqual(out['suggested_requirements']['card'],'c')
        self.assertTrue(out['flow']['ready'])

    def test_explicit_value_supersedes_flexible_policy(self):
        request=service.clean_request({**REQUEST,'requirements':{},'hard_constraints':[],
            'flexible_fields':['inputK'],'suggested_requirements':{'inputK':8}})
        out=service.clean_response({'assistant_message':'','requirements':self.complete()},request)
        self.assertEqual(out['flexible_fields'],[])
        self.assertEqual(out['suggested_requirements'],{})

    def test_locked_condition_cannot_become_flexible(self):
        request=service.clean_request({**REQUEST,'requirements':self.complete(),'hard_constraints':['inputK']})
        out=service.clean_response({'assistant_message':'','requirements':{},'flexible_fields':['inputK'],
            'suggested_requirements':{'inputK':16}},request)
        self.assertEqual(out['requirements']['inputK'],12)
        self.assertNotIn('inputK',out['flexible_fields'])

    def test_untyped_rate_never_becomes_a_constraint_or_lock(self):
        for number in [13,55,700]:
            out=self.reply({'throughput':number},hard_constraints=['throughput'])
            self.assertNotIn('throughput',out['requirements'])
            self.assertNotIn('throughput',out['hard_constraints'])

    def test_domestic_preference_is_enough_to_recommend_a_chip(self):
        req=self.complete();del req['card'];req['domesticOnly']=True
        out=self.reply(req)
        self.assertIn('card',out['flexible_fields'])
        self.assertNotIn('必须用国产芯片吗',out['flow']['question'])

    def test_missing_is_not_flexible_without_customer_evidence(self):
        request=service.clean_request({**REQUEST,'scenario_text':'只指定一个模型','requirements':{},'hard_constraints':[]})
        out=service.clean_response({'assistant_message':'','requirements':{'model':'m'},
            'flexible_fields':['precision','speed'],'flexible_evidence':{'precision':'客户没有说过这句话'}},request)
        self.assertEqual(out['flexible_fields'],[])


if __name__=='__main__':
    unittest.main()
