module.exports = {
    app: {
      isPackaged: false,
      getPath: (k) => require('os').homedir() + '/Library/Application Support/focuclone',
      getAppPath: () => '/Users/harshkasana/PROJECTS/MacStore/FocuClone'
    }
  }