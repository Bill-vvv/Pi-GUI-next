import assert from 'node:assert/strict'
import test from 'node:test'

import { hostLogDirectory, hostUserDataDirectory } from './host-paths.ts'

// Expected values were measured with Electron 43.1.1 app.getPath() for an app named pi-gui-next.
test('the Node Host uses the Electron userData and logs directories', () => {
  assert.equal(hostUserDataDirectory({}, '/home/user'), '/home/user/.config/pi-gui-next')
  assert.equal(hostUserDataDirectory({ XDG_CONFIG_HOME: '/srv/xdg' }, '/home/user'), '/srv/xdg/pi-gui-next')
  assert.equal(hostUserDataDirectory({ XDG_CONFIG_HOME: '' }, '/home/user'), '/home/user/.config/pi-gui-next')
  assert.equal(hostLogDirectory('/home/user/.config/pi-gui-next'), '/home/user/.config/pi-gui-next/logs')
  assert.throws(() => hostUserDataDirectory({ XDG_CONFIG_HOME: 'relative' }, '/home/user'), /must be absolute/u)
})
