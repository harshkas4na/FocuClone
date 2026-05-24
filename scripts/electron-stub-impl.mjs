import os from 'os'
export const app = {
  isPackaged: false,
  getPath: (k) => os.homedir() + '/Library/Application Support/focuclone',
  getAppPath: () => process.cwd()
}
export default { app }
