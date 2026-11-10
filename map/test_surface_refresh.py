import unittest
from types import SimpleNamespace as S
from unittest.mock import patch
from surface_layers import column, MAX_LAYERS
from surface_refresh import SurfaceRefresh

class LayersTest(unittest.TestCase):
    def world(self, levels, top):
        world=S(name='Overworld')
        def get(x,y,z): return S(x=x,y=y,z=z,data=S(type='minecraft:'+levels.get(y,'air'),block_states={}))
        world.get_block_at=get;world.get_highest_block_at=lambda x,z:get(x,top,z)
        world.loaded_chunks=[S(x=0,z=0,dimension=world)]
        return world
    def test_actual_ground_under_torch_flower_glass_and_air_gap(self):
        for name in ['torch','dandelion','glass','red_stained_glass','glass_pane','wheat']:
            with self.subTest(name=name):
                result=list(column(self.world({120:name,63:'stone'},120),2,-3,set()))[-1]
                self.assertEqual(result['name'],'minecraft:'+name)
                self.assertEqual(result['layers'][0]['name'],'minecraft:stone')
                self.assertEqual(result['layers'][0]['coordinates'],[2,63,-3])
                self.assertTrue(result['layers_complete'])
    def test_multiple_layers_and_blacklist(self):
        result=list(column(self.world({66:'torch',65:'red_stained_glass',64:'glass',63:'sand'},66),0,0,{'minecraft:torch'}))[-1]
        self.assertEqual(result['name'],'minecraft:red_stained_glass')
        self.assertEqual([b['name'] for b in result['layers']],['minecraft:glass','minecraft:sand'])
    def test_deep_transparency_is_bounded_and_not_given_fake_ground(self):
        result=list(column(self.world({y:'glass' for y in range(0,101)},100),0,0,set()))[-1]
        self.assertEqual(len(result['layers']),MAX_LAYERS-1)
        self.assertFalse(result['layers_complete'])
    def test_budget_retry_forced_ack_and_unload(self):
        world=self.world({66:'torch',63:'grass_block'},66);sent=[]
        plugin=S(config={},server=S(current_tps=20,level=S(dimensions=[world],get_dimension=lambda _:world)),_chunksQueue=S(put=sent.append))
        capture=SurfaceRefresh(plugin)
        with patch('surface_refresh.time.perf_counter',return_value=0),patch('surface_refresh.time.monotonic',return_value=10):
            capture.step();self.assertLessEqual(capture.reads,256);self.assertEqual(sent,[])
            for _ in range(200):
                capture.step()
                if sent:break
            self.assertEqual(len(sent),1);self.assertEqual(len(sent[0]['chunk']['blocks']),256)
            for _ in range(40):capture.step()
            self.assertEqual(len(sent),1)
            capture.enqueue(world.loaded_chunks[0],force=True)
            for _ in range(40):capture.step()
            self.assertEqual(len(sent),2,'Repeated loadmap events still receive an upload acknowledgement')
            world.loaded_chunks=[]
            for _ in range(20):capture.step()
            self.assertIsNone(capture.active);self.assertFalse(capture.sent)
if __name__=='__main__':unittest.main()
