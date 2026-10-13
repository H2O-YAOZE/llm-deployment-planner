import copy, importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sync',ROOT/'scripts/catalog_sync.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)

class SyncTests(unittest.TestCase):
    def test_sources_require_official_publisher_and_https(self):
        self.assertTrue(sync.allowed('https://huggingface.co/Qwen/Model/resolve/main/config.json'))
        self.assertTrue(sync.allowed('https://huggingface.co/api/resolve-cache/models/Qwen/Model/abc/config.json'))
        for url in ['http://www.nvidia.com/test','https://huggingface.co/community/Model/config.json',
                    'https://127.0.0.1/config.json','https://www.nvidia.com.evil.test/test','https://u:p@www.nvidia.com/test',
                    'https://huggingface.co/api/resolve-cache/models/community/Model/abc/config.json']:
            self.assertFalse(sync.allowed(url))
    def price(self):
        return {'sourceType':'official','endpoint':'model-flash','currency':'CNY','native':{'miss':1,'hit':0.02,'out':4},'tiers':[]}
    def test_price_anchor_only_changes_exact_price_cells(self):
        row=self.price();page=b'CNY per million Token\nmodel-flash | 1 | 0.02 | 4\nNo other fees'
        anchor=sync.price_observation(row,page)
        self.assertIsNotNone(anchor)
        changed=page.replace(b'| 1 |',b'| 0.5 |')
        self.assertEqual(sync.price_observation(row,changed,anchor)['lastValues']['miss'],0.5)
        self.assertIsNone(sync.price_observation(row,changed.replace(b'CNY',b'USD'),anchor))
        self.assertIsNone(sync.price_observation(row,changed+b'\nNew peak fees x2',anchor))
    def test_manual_edit_and_tiers_block_auto_price(self):
        row=self.price();page=b'CNY\nmodel-flash | 1 | 0.02 | 4';anchor=sync.price_observation(row,page)
        row['native']['miss']=2
        self.assertIsNone(sync.price_observation(row,page,anchor))
        row=self.price();row['tiers']=[{'maxInputTokens':1000}]
        self.assertIsNone(sync.price_observation(row,page))
    def test_ambiguous_rows_or_repeated_numeric_values_rejected(self):
        self.assertIsNone(sync.price_observation(self.price(),b'model-flash | 1 | 0.02 | 4\nmodel-flash | 3 | 2 | 6'))
        self.assertIsNone(sync.price_observation(self.price(),b'model-flash | 1 | 1 | 0.02 | 4'))
    def test_structural_change_quarantined(self):
        changes=sync.model_differences({'layers':43,'nativeContextTokens':1048576},
            {'model_type':'deepseek_v4','num_hidden_layers':44,'max_position_embeddings':1048576})
        self.assertEqual(changes,[{'field':'layers','before':43,'after':44}])
        with self.assertRaises(ValueError):sync.model_differences({}, {'error':'Not found'})
    def test_h200_sxm_does_not_take_nvl_column(self):
        row={'layers':2,'cacheProfile':{'compressRatios':[0,128],'slidingWindow':0}}
        self.assertEqual(sync.model_differences(row,{'model_type':'deepseek','compress_ratios':[0,128,0],'sliding_window':None}),[])
        self.assertIsNone(sync.price_observation(self.price(),b'model-flash | 1 | 0.02 | 4'))
        data=b'<table><tr><th>Spec</th><th>H200 SXM</th><th>H200 NVL</th></tr><tr><td>GPU Memory</td><td>141 GB</td><td>282 GB</td></tr><tr><td>Memory Bandwidth</td><td>4.8 TB/s</td><td>9.6 TB/s</td></tr><tr><td>Power</td><td>700 W</td><td>600 W</td></tr></table>'
        self.assertEqual(sync.h200_specs(data),{'memoryGB':141,'bandwidthGBs':4800,'tdpW':700})
        with self.assertRaises(ValueError):sync.h200_specs(b'141 GB 4.8 TB/s')
    def test_context_requires_unchanged_rope_architecture_and_no_manual_edit(self):
        row={'nativeContextTokens':8000,'layers':43}
        cfg={'model_type':'test','num_hidden_layers':43,'max_position_embeddings':8000,'rope_scaling':{'factor':1}}
        anchor=sync.context_observation(row,cfg);self.assertIsNotNone(anchor)
        cfg['max_position_embeddings']=16000
        self.assertEqual(sync.context_observation(row,cfg,anchor)['lastValue'],16000)
        cfg['rope_scaling']['factor']=2
        self.assertIsNone(sync.context_observation(row,cfg,anchor))
        cfg['rope_scaling']['factor']=1;row['nativeContextTokens']=4000
        self.assertIsNone(sync.context_observation(row,cfg,anchor))
    def test_publish_rejects_concurrent_edit(self):
        cfg={'model_type':'qwen3','num_hidden_layers':32,'num_attention_heads':32,'num_key_value_heads':8,'hidden_size':4096,'torch_dtype':'bfloat16','max_position_embeddings':32768}
        metadata={'safetensors':{'parameters':{'BF16':8000000000}},'cardData':{'license':'apache-2.0'},'createdAt':'2026-10-01T00:00:00Z'}
        model=sync.new_dense_model('Qwen/TestNew',cfg,metadata,'2026-10-13T00:00:00Z')
        self.assertEqual(model['verifiedStructure']['kvWidth'],2048);self.assertEqual(model['totalParamsB'],8);self.assertFalse(model['catalogOnly'])
        cfg['quantization_config']={'quant_method':'fp8'};self.assertIsNone(sync.new_dense_model('Qwen/TestNew',cfg,metadata,'2026-10-13T00:00:00Z'))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'catalog.json').write_bytes(b'new')
            with self.assertRaises(ValueError):sync.publish(root,{},b'old',{'runId':'test'})
            self.assertEqual((root/'catalog.json').read_bytes(),b'new')
    def test_publish_rolls_back_both_files_when_build_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'scripts').mkdir()
            (root/'scripts/build-catalog.py').write_text('def build():\n raise ValueError("broken")\n')
            (root/'catalog.json').write_bytes(b'{}');(root/'data.js').write_bytes(b'old-js')
            with self.assertRaises(ValueError):sync.publish(root,{},b'{}',{'runId':'test'})
            self.assertEqual((root/'catalog.json').read_bytes(),b'{}')
            self.assertEqual((root/'data.js').read_bytes(),b'old-js')
    def test_no_change_keeps_previous_actual_update(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'scripts').mkdir();(root/'sync-state').mkdir()
            (root/'scripts/build-catalog.py').write_bytes((ROOT/'scripts/build-catalog.py').read_bytes())
            catalog={'models':{'m':{'id':'m','name':'M','sourceType':'official','configSource':'https://huggingface.co/Qwen/M/resolve/main/config.json','layers':43}},'cards':{},'apiPrices':{}}
            (root/'catalog.json').write_bytes(sync.encoded(catalog));(root/'data.js').write_bytes(b'old')
            last={'lastUpdatedAt':'2026-10-01T00:00:00+00:00','lastChanges':{'models':[{'name':'M'}]}}
            (root/'sync-state/latest.json').write_bytes(sync.encoded(last))
            with patch.object(sync,'source_registry',return_value={catalog['models']['m']['configSource']:[('models','m')]}),patch.object(sync,'fetch',return_value=b'{"model_type":"test","num_hidden_layers":43}'),patch.object(sync,'discover',return_value={'ok':True}):
                result=sync.run(root,use_llm=False)
            actual=json.loads((root/'catalog.json').read_bytes())['dataSync']
            self.assertEqual(actual['lastUpdatedAt'],last['lastUpdatedAt'])
            self.assertEqual(actual['lastChanges'],last['lastChanges'])
            self.assertEqual(result['changed']['models'],0)
            with patch.object(sync,'discover',return_value={'ok':True}),patch.object(sync,'fetch',side_effect=AssertionError('should not fetch')):
                self.assertTrue(sync.run(root,if_due=True)['skipped'])

if __name__=='__main__':unittest.main()
