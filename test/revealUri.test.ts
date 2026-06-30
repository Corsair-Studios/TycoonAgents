import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWindowsUserDataPath } from '../src/host/vscode/revealUri';

test('nativeWindowsUserDataPath converts desktop userdata URIs for Explorer', () => {
  assert.equal(
    nativeWindowsUserDataPath(
      'vscode-userdata',
      '/c:/Users/example/AppData/Roaming/Code/User/globalStorage/theme_images/agent.png',
      'win32',
    ),
    'c:\\Users\\example\\AppData\\Roaming\\Code\\User\\globalStorage\\theme_images\\agent.png',
  );
});

test('nativeWindowsUserDataPath leaves file and non-Windows resources alone', () => {
  assert.equal(nativeWindowsUserDataPath('file', '/c:/theme/agent.png', 'win32'), undefined);
  assert.equal(nativeWindowsUserDataPath('vscode-userdata', '/c:/theme/agent.png', 'linux'), undefined);
  assert.equal(nativeWindowsUserDataPath('vscode-remote', '/home/example/agent.png', 'win32'), undefined);
});
