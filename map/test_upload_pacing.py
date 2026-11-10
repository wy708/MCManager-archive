import ast
import asyncio
import queue
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace as S
import unittest
from zipfile import ZipFile
from prepare_plugin import prepare, VERSION
from players_sender import PlayersSender


class Session:
    def __init__(self): self.sent=[];self.status=200
    def post(self, url, json, timeout):
        self.sent.append(json)
        parent=self
        class Response:
            status=parent.status
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            async def read(self): return b'{}'
        return Response()


class PacingTest(unittest.IsolatedAsyncioTestCase):
    async def test_latest_state_dedup_keepalive_retry_and_departure(self):
        sender=PlayersSender({'api':{'players':'http://localhost/test'}});q=queue.Queue();http=Session()
        for x in range(40):q.put({'players':[{'x':x}]})
        self.assertTrue(await sender.step(http,q,100));self.assertEqual(http.sent,[{'players':[{'x':39}]}])
        self.assertFalse(await sender.step(http,q,106))
        q.put({'players':[{'x':99}]});self.assertTrue(await sender.step(http,q,110))
        q.put({'players':[]});http.status=503;self.assertFalse(await sender.step(http,q,115))
        http.status=200;self.assertFalse(await sender.step(http,q,120));self.assertTrue(await sender.step(http,q,126));self.assertEqual(http.sent[-1],{'players':[]})
        self.assertFalse(await sender.step(http,q,140));self.assertTrue(await sender.step(http,q,157))

    async def test_repeated_join_and_quit_do_not_multiply_timers(self):
        with TemporaryDirectory() as folder:
            prepare(Path(__file__).parent/'dist/endstone_mipmap-1.0.3-py2.py3-none-any.whl',Path(folder))
            with ZipFile(Path(folder)/f'endstone_mipmap-{VERSION}-py2.py3-none-any.whl') as z:
                tree=ast.parse(z.read('endstone_mipmap/main.py').decode())
                methods=[m for c in tree.body if isinstance(c,ast.ClassDef) and c.name=='Map' for m in c.body if isinstance(m,ast.FunctionDef) and m.name in {'_sendPlayers','_schedulePlayersUpdate','_periodicPlayers','onPlayerJoin','onPlayerQuit'}]
                for m in methods:m.decorator_list=[];m.returns=None;[setattr(a,'annotation',None) for a in m.args.args]
                cls=ast.ClassDef(name='Map',bases=[],keywords=[],body=methods,decorator_list=[]);module=ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[]));ns={'queue':queue};exec(compile(module,'timer-test','exec'),ns)
                plugin=ns['Map']();pending=[];plugin.config={'sendPlayers':True};plugin._playersQueue=queue.Queue(maxsize=2)
                plugin.server=S(online_players=[],scheduler=S(run_task=lambda _,callback,**kwargs:pending.append(callback)))
                plugin._schedulePlayersUpdate()
                for _ in range(200):plugin.onPlayerJoin(None);plugin.onPlayerQuit(None)
                self.assertEqual(len(pending),1);self.assertLessEqual(plugin._playersQueue.qsize(),2)
                for _ in range(20):pending.pop(0)();self.assertEqual(len(pending),1)
                source=z.read('endstone_mipmap/core/chunksSender.py').decode();self.assertNotIn('create_task',source);self.assertIn('range(4)',source)

if __name__=='__main__':unittest.main()
