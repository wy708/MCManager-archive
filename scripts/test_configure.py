import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT=pathlib.Path(__file__).with_name('configure.py')
class ConfigurationTests(unittest.TestCase):
    def test_fresh_config_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            result=subprocess.run([sys.executable,str(SCRIPT),'--public-url','https://mc.example.com'],cwd=directory,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            content=(pathlib.Path(directory)/'.env').read_text()
            values=dict(line.split('=',1) for line in content.splitlines() if '=' in line)
            self.assertEqual(values['MCM_COOKIE_SECURE'],'true')
            self.assertNotEqual(values['MCM_DB_PASSWORD'],values['MCM_ADMIN_PASSWORD'])
            self.assertGreaterEqual(len(values['MCM_ADMIN_PASSWORD']),40)
            self.assertNotIn(values['MCM_ADMIN_PASSWORD'],result.stdout)
            again=subprocess.run([sys.executable,str(SCRIPT),'--public-url','https://mc.example.com'],cwd=directory,capture_output=True)
            self.assertNotEqual(again.returncode,0)
            self.assertEqual((pathlib.Path(directory)/'.env').read_text(),content)
    def test_rejects_bad_origins_without_writing(self):
        for origin in ['http://mc.example.com','https://user:secret@mc.example.com','https://mc.example.com/api','https://mc.example.com?key=secret','https://mc.example.com\nMCM_ADMIN_PASSWORD=unsafe']:
            with self.subTest(origin=origin),tempfile.TemporaryDirectory() as directory:
                result=subprocess.run([sys.executable,str(SCRIPT),'--public-url',origin],cwd=directory,capture_output=True)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse((pathlib.Path(directory)/'.env').exists())
    def test_loopback_development(self):
        with tempfile.TemporaryDirectory() as directory:
            result=subprocess.run([sys.executable,str(SCRIPT),'--public-url','http://localhost:8088'],cwd=directory,capture_output=True)
            self.assertEqual(result.returncode,0)
            self.assertIn('MCM_COOKIE_SECURE=false',(pathlib.Path(directory)/'.env').read_text())
if __name__=='__main__':unittest.main()
