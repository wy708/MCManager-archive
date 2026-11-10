"""Latest-state map transport. This is not the durable gameplay event uploader."""
import asyncio
import json
import time
from queue import Empty
import aiohttp


class PlayersSender:
    def __init__(self, config):
        self.url = config.get('api', {}).get('players')
        self.timeout = 5
        self.interval = max(2, min(30, float(config.get('playerUploadSeconds', 5))))
        self.keepalive = max(self.interval, min(120, float(config.get('playerKeepaliveSeconds', 30))))
        self.latest = None
        self.sent = None
        self.last_success = 0
        self.next_attempt = 0
        self.failures = 0

    def drain(self, queue):
        # Bounded work per loop even with an older or malfunctioning producer.
        for _ in range(128):
            try:
                self.latest = queue.get_nowait()
            except Empty:
                break

    async def step(self, session, queue, now=None):
        self.drain(queue)
        now = time.monotonic() if now is None else now
        if self.latest is None or now < self.next_attempt:
            return False
        fingerprint = json.dumps(self.latest, sort_keys=True, separators=(',', ':'))
        if fingerprint == self.sent and now - self.last_success < self.keepalive:
            return False
        payload = self.latest
        try:
            async with session.post(self.url, json=payload, timeout=self.timeout) as response:
                await response.read()
                if response.status != 200:
                    raise RuntimeError('HTTP ' + str(response.status))
            self.sent = fingerprint
            self.last_success = now
            self.failures = 0
            self.next_attempt = now + self.interval
            return True
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError):
            self.failures += 1
            self.next_attempt = now + min(30, self.interval * 2 ** min(self.failures, 3))
            if self.failures == 1:
                print('[Mipmap] Player map upload delayed; keeping the newest state for retry.')
            return False

    async def run(self, queue):
        # One request in flight; no create_task for every queued snapshot.
        async with aiohttp.ClientSession() as session:
            while True:
                await self.step(session, queue)
                await asyncio.sleep(.1)
