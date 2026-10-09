from __future__ import annotations

import base64
import hashlib
import json
import secrets
import tempfile
from dataclasses import replace
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import cbor2
import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from backend.app.application import create_app
from backend.app.database import Database
from backend.tests.helpers import test_settings


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


class PasskeyTests(IsolatedAsyncioTestCase):
    """A software authenticator exercises the real WebAuthn verifier/signatures."""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = replace(test_settings(Path(self.temp.name)),
                                webauthn_origin='https://orbitpane.test', environment='production')
        self.app = create_app(self.settings)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                       base_url='https://orbitpane.test',
                                       headers={'Origin': 'https://orbitpane.test'})
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = secrets.token_bytes(32)

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)
        self.temp.cleanup()

    def credential(self, challenge, *, register=False, origin='https://orbitpane.test',
                   rp='orbitpane.test', uv=True, counter=0, user=b'orbitpane-user'):
        client_data = json.dumps({'type': 'webauthn.create' if register else 'webauthn.get',
                                  'challenge': challenge, 'origin': origin}).encode()
        flags = 0x01 | (0x04 if uv else 0) | (0x40 if register else 0)
        auth_data = hashlib.sha256(rp.encode()).digest() + bytes([flags]) + counter.to_bytes(4, 'big')
        response = {'clientDataJSON': b64(client_data)}
        if register:
            numbers = self.key.public_key().public_numbers()
            cose_key = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, 'big'),
                                   -3: numbers.y.to_bytes(32, 'big')})
            auth_data += bytes(16) + len(self.credential_id).to_bytes(2, 'big') + self.credential_id + cose_key
            response['attestationObject'] = b64(cbor2.dumps({'fmt': 'none', 'attStmt': {}, 'authData': auth_data}))
        else:
            response.update(authenticatorData=b64(auth_data), userHandle=b64(user),
                            signature=b64(self.key.sign(auth_data + hashlib.sha256(client_data).digest(),
                                                        ec.ECDSA(hashes.SHA256()))))
        return {'id': b64(self.credential_id), 'rawId': b64(self.credential_id),
                'type': 'public-key', 'response': response}

    async def options(self, purpose):
        response = await self.client.post(f'/api/passkeys/{purpose}/options')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def verify(self, purpose, credential):
        return await self.client.post(f'/api/passkeys/{purpose}/verify', json={'credential': credential})

    async def register(self):
        response = await self.client.post('/api/login', json={'pin': 'test-pin'})
        self.assertEqual(response.status_code, 200)
        options = await self.options('register')
        self.assertEqual(options['authenticatorSelection']['residentKey'], 'required')
        self.assertEqual(options['authenticatorSelection']['userVerification'], 'required')
        response = await self.verify('register', self.credential(options['challenge'], register=True))
        self.assertEqual(response.status_code, 200, response.text)
        await self.client.post('/api/logout')

    async def test_register_logout_login_and_replay_rejected(self):
        await self.register()
        # Persistence survives reopening the repository.
        self.assertIsNotNone(Database(self.settings.database_path).get_passkey(self.credential_id))
        options = await self.options('login')
        self.assertFalse(options.get('allowCredentials'))
        self.assertEqual(options['userVerification'], 'required')
        credential = self.credential(options['challenge'], counter=1)
        response = await self.verify('login', credential)
        self.assertEqual(response.status_code, 200, response.text)
        cookie = response.headers['set-cookie']
        for attribute in ['HttpOnly', 'Secure', 'SameSite=lax']:
            self.assertIn(attribute, cookie)
        self.assertEqual((await self.client.get('/api/session')).status_code, 200)
        self.assertEqual(self.app.state.database.get_passkey(self.credential_id)['sign_count'], 1)
        self.assertEqual((await self.verify('login', credential)).status_code, 400)
        options = await self.options('login')
        self.assertEqual((await self.verify('login', self.credential(options['challenge'], counter=1))).status_code, 400)

    async def test_synced_passkey_zero_counter_can_login_repeatedly(self):
        await self.register()
        for _ in range(2):
            options = await self.options('login')
            self.assertEqual((await self.verify('login', self.credential(options['challenge']))).status_code, 200)
            await self.client.post('/api/logout')

    async def test_registration_requires_login_and_trusted_origin(self):
        for path in ['options', 'verify']:
            response = await self.client.post('/api/passkeys/register/' + path, json={'credential': {}})
            self.assertEqual(response.status_code, 401)
        await self.client.post('/api/login', json={'pin': 'test-pin'})
        for purpose in ['register', 'login']:
            response = await self.client.post(f'/api/passkeys/{purpose}/options', headers={'Origin': 'https://evil.test'})
            self.assertEqual(response.status_code, 403)
        options = await self.options('register')
        response = await self.verify('register', self.credential(options['challenge'], register=True, uv=False))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.app.state.database.passkey_ids(), [])

    async def test_wrong_origin_rp_challenge_user_signature_and_missing_uv_rejected(self):
        await self.register()
        cases = [{'origin': 'https://evil.test'}, {'rp': 'evil.test'}, {'uv': False},
                 {'user': b'someone-else'}, {'challenge': b64(b'wrong')}]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                options = await self.options('login')
                params = {'challenge': options['challenge'], **overrides}
                response = await self.verify('login', self.credential(**params))
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual((await self.client.get('/api/session')).status_code, 401)
        options = await self.options('login')
        credential = self.credential(options['challenge'])
        credential['response']['signature'] = b64(b'fake')
        self.assertEqual((await self.verify('login', credential)).status_code, 400)

    async def test_expired_browser_bound_and_wrong_purpose_challenges_rejected(self):
        await self.register()
        options = await self.options('login')
        credential = self.credential(options['challenge'])
        cookie = self.client.cookies.get('orbitpane_webauthn')
        self.client.cookies.clear()
        self.assertEqual((await self.verify('login', credential)).status_code, 400)
        self.client.cookies.set('orbitpane_webauthn', cookie, path='/api/passkeys')
        with patch('backend.app.database.time.time', return_value=10**12):
            self.assertEqual((await self.verify('login', credential)).status_code, 400)
        await self.client.post('/api/login', json={'pin': 'test-pin'})
        options = await self.options('login')
        self.assertEqual((await self.verify('register', self.credential(options['challenge'], register=True))).status_code, 400)

    async def test_invalid_payloads_do_not_crash_and_unknown_keys_are_rejected(self):
        for credential in [{}, {'rawId': []}, {'rawId': 'a'}, self.credential(b64(b'unknown'))]:
            await self.options('login')
            response = await self.verify('login', credential)
            self.assertEqual(response.status_code, 400, response.text)

    async def test_limiter_does_not_block_pin_fallback(self):
        self.app.state.passkey_limiter.max_attempts = 1
        await self.options('login')
        self.assertEqual((await self.client.post('/api/passkeys/login/options')).status_code, 429)
        self.assertEqual((await self.client.post('/api/login', json={'pin': 'test-pin'})).status_code, 200)

    async def test_unconfigured_passkeys_leave_pin_available(self):
        app = create_app(replace(self.settings, webauthn_origin=''))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://orbitpane.test') as client:
            self.assertEqual((await client.post('/api/passkeys/login/options')).status_code, 503)
            self.assertEqual((await client.post('/api/login', json={'pin': 'test-pin'})).status_code, 200)
