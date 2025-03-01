const path = require('path')
const _ = require('underscore-plus')
const {CompositeDisposable, Emitter} = require('atom')
const fs = require('fs-plus')
const PathWatcher = require('pathwatcher')
const File = require('./file')
const {repoForPath} = require('./helpers')

module.exports =
class Directory {
  constructor ({name, fullPath, symlink, expansionState, isRoot, ignoredNames, useSyncFS, stats}) {
    this.name = name
    this.symlink = symlink
    this.expansionState = expansionState
    this.isRoot = isRoot
    this.ignoredNames = ignoredNames
    this.useSyncFS = useSyncFS
    this.stats = stats
    this.destroyed = false
    this.emitter = new Emitter()
    this.subscriptions = new CompositeDisposable()

    if (atom.config.get('tree-view.squashDirectoryNames') && !this.isRoot) {
      fullPath = this.squashDirectoryNames(fullPath)
    }

    this.path = fullPath
    this.realPath = this.path
    if (fs.isCaseInsensitive()) {
      this.lowerCasePath = this.path.toLowerCase()
      this.lowerCaseRealPath = this.lowerCasePath
    }

    if (this.isRoot == null) {
      this.isRoot = false
    }

    if (this.expansionState == null) {
      this.expansionState = {}
    }

    if (this.expansionState.isExpanded == null) {
      this.expansionState.isExpanded = false
    }

    // TODO: This can be removed after a sufficient amount
    // of time has passed since @expansionState.entries
    // has been converted to a Map
    if (!(this.expansionState.entries instanceof Map)) {
      const convertEntriesToMap = entries => {
        const temp = new Map()
        for (let name in entries) {
          const entry = entries[name]
          if (entry.entries != null) {
            entry.entries = convertEntriesToMap(entry.entries)
          }
          temp.set(name, entry)
        }
        return temp
      }

      this.expansionState.entries = convertEntriesToMap(this.expansionState.entries)
    }

    if (this.expansionState.entries == null) {
      this.expansionState.entries = new Map()
    }

    this.status = null
    this.entries = new Map()

    const repo = repoForPath(this.path)
    this.submodule = repo && repo.isSubmodule(this.path)

    this.subscribeToRepo()
    this.updateStatus()
    this.loadRealPath()
  }

  destroy () {
    this.destroyed = true
    this.unwatch()
    this.subscriptions.dispose()
    this.emitter.emit('did-destroy')
  }

  onDidDestroy (callback) {
    return this.emitter.on('did-destroy', callback)
  }

  onDidStatusChange (callback) {
    return this.emitter.on('did-status-change', callback)
  }

  onDidAddEntries (callback) {
    return this.emitter.on('did-add-entries', callback)
  }

  onDidRemoveEntries (callback) {
    return this.emitter.on('did-remove-entries', callback)
  }

  onDidCollapse (callback) {
    return this.emitter.on('did-collapse', callback)
  }

  onDidExpand (callback) {
    return this.emitter.on('did-expand', callback)
  }

  loadRealPath () {
    if (this.useSyncFS) {
      this.realPath = fs.realpathSync(this.path)
      if (fs.isCaseInsensitive()) {
        this.lowerCaseRealPath = this.realPath.toLowerCase()
      }
    } else {
      fs.realpath(this.path, (error, realPath) => {
        // FIXME: Add actual error handling
        if (error || this.destroyed) return
        if (realPath && (realPath !== this.path)) {
          this.realPath = realPath
          if (fs.isCaseInsensitive()) {
            this.lowerCaseRealPath = this.realPath.toLowerCase()
          }
          this.updateStatus()
        }
      })
    }
  }

  // Subscribe to project's repo for changes to the Git status of this directory.
  subscribeToRepo () {
    const repo = repoForPath(this.path)
    if (repo == null) return

    this.subscriptions.add(repo.onDidChangeStatus(event => {
      if (this.contains(event.path)) {
        this.updateStatus(repo)
      }
    }))
    this.subscriptions.add(repo.onDidChangeStatuses(() => {
      this.updateStatus(repo)
    }))
  }

  // Update the status property of this directory using the repo.
  updateStatus () {
    const repo = repoForPath(this.path)
    if (repo == null) return

    let newStatus = null
    if (repo.isPathIgnored(this.path)) {
      newStatus = 'ignored'
    } else if (this.ignoredNames.matches(this.path)) {
      newStatus = 'ignored-name'
    } else {
      let status
      if (this.isRoot) {
        // repo.getDirectoryStatus will always fail for the
        // root because the path is relativized + concatenated with '/'
        // making the matching string be '/'.  Then path.indexOf('/')
        // is run and will never match beginning of string with a leading '/'
        for (let statusPath in repo.statuses) {
          status |= parseInt(repo.statuses[statusPath], 10)
        }
      } else {
        status = repo.getDirectoryStatus(this.path)
      }

      if (repo.isStatusModified(status)) {
        newStatus = 'modified'
      } else if (repo.isStatusNew(status)) {
        newStatus = 'added'
      }
    }

    if (newStatus !== this.status) {
      this.status = newStatus
      this.emitter.emit('did-status-change', newStatus)
    }
  }

  // Is the given path ignored?
  isPathIgnored (filePath) {
    if (atom.config.get('tree-view.hideVcsIgnoredFiles')) {
      const repo = repoForPath(this.path)
      if (repo && repo.isProjectAtRoot() && repo.isPathIgnored(filePath)) return true
    }

    if (atom.config.get('tree-view.hideIgnoredNames')) {
      if (this.ignoredNames.matches(filePath)) return true
    }

    return false
  }

  // Does given full path start with the given prefix?
  isPathPrefixOf (prefix, fullPath) {
    return fullPath.indexOf(prefix) === 0 && fullPath[prefix.length] === path.sep
  }

  isPathEqual (pathToCompare) {
    return this.path === pathToCompare || this.realPath === pathToCompare
  }

  // Public: Does this directory contain the given path?
  //
  // See atom.Directory::contains for more details.
  contains (pathToCheck) {
    if (!pathToCheck) return false

    // Normalize forward slashes to back slashes on Windows
    if (process.platform === 'win32') {
      pathToCheck = pathToCheck.replace(/\//g, '\\')
    }

    let directoryPath
    if (fs.isCaseInsensitive()) {
      directoryPath = this.lowerCasePath
      pathToCheck = pathToCheck.toLowerCase()
    } else {
      directoryPath = this.path
    }

    if (this.isPathPrefixOf(directoryPath, pathToCheck)) return true

    // Check real path
    if (this.realPath !== this.path) {
      if (fs.isCaseInsensitive()) {
        directoryPath = this.lowerCaseRealPath
      } else {
        directoryPath = this.realPath
      }

      return this.isPathPrefixOf(directoryPath, pathToCheck)
    }

    return false
  }

  // Public: Stop watching this directory for changes.
  unwatch () {
    if (this.watchSubscription != null) {
      this.watchSubscription.close()
      this.watchSubscription = null
    }

    for (let [key, entry] of this.entries) {
      entry.destroy()
      this.entries.delete(key)
    }
  }

  // Public: Watch this directory for changes.
  watch () {
    if (this.watchSubscription != null) return
    try {
      this.watchSubscription = PathWatcher.watch(this.path, eventType => {
        switch (eventType) {
          case 'change':
            this.reload()
            break
          case 'delete':
            this.destroy()
            break
        }
      })
    } catch (error) {}
  }

  getEntries () {

    console.time("getentries")

    // change
    console.time("getentriesread")

    let contents
    try {
      contents = fs.readdirSync(this.path, {withFileTypes : true})
    } catch (error) {
      contents = []
    }

    let names = contents.map(e => e.name);

    let stats = {}
    for(const e of contents) {
      stats[e.name] = e;
    }

    // end change

    names.sort(new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'}).compare)
    console.timeEnd("getentriesread")

    const files = []
    const directories = []

    for (let name of names) {
      const fullPath = path.join(this.path, name)
      if (this.isPathIgnored(fullPath)) continue

      // change

      // let stat = fs.lstatSyncNoException(fullPath)
      let stat = stats[name]

      // end change

      const symlink = typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()
      if (symlink) {
        stat = fs.statSyncNoException(fullPath)
      }

      const statFlat = _.pick(stat, _.keys(stat))
      for (let key of ['atime', 'birthtime', 'ctime', 'mtime']) {
        statFlat[key] = statFlat[key] && statFlat[key].getTime()
      }

      if (typeof stat.isDirectory === 'function' && stat.isDirectory()) {
        if (this.entries.has(name)) {
          // push a placeholder since this entry already exists but this helps
          // track the insertion index for the created views
          directories.push(name)
        } else {
          const expansionState = this.expansionState.entries.get(name)
          directories.push(new Directory({
            name,
            fullPath,
            symlink,
            expansionState,
            ignoredNames: this.ignoredNames,
            useSyncFS: this.useSyncFS,
            stats: statFlat
          }))
        }
      } else if (typeof stat.isFile === 'function' && stat.isFile()) {
        if (this.entries.has(name)) {
          // push a placeholder since this entry already exists but this helps
          // track the insertion index for the created views
          files.push(name)
        } else {
          files.push(new File({name, fullPath, symlink, ignoredNames: this.ignoredNames, useSyncFS: this.useSyncFS, stats: statFlat}))
        }
      }
    }

    const res = this.sortEntries(directories.concat(files))

    console.timeEnd("getentries")
    return res;
  }

  normalizeEntryName (value) {
    let normalizedValue = value.name
    if (normalizedValue == null) {
      normalizedValue = value
    }

    if (normalizedValue != null) {
      normalizedValue = normalizedValue.toLowerCase()
    }
    return normalizedValue
  }

  sortEntries (combinedEntries) {
    if (atom.config.get('tree-view.sortFoldersBeforeFiles')) {
      return combinedEntries
    } else {
      return combinedEntries.sort((first, second) => {
        const firstName = this.normalizeEntryName(first)
        const secondName = this.normalizeEntryName(second)
        return firstName.localeCompare(secondName)
      })
    }
  }

  // Public: Perform a synchronous reload of the directory.
  reload () {
    console.time("reload")
    const newEntries = []
    const removedEntries = new Map(this.entries)

    console.time("reload middle")

    let index = 0
    for (let entry of this.getEntries()) {
      if (this.entries.has(entry)) {
        removedEntries.delete(entry)
        index++
        continue
      }

      entry.indexInParentDirectory = index
      index++
      newEntries.push(entry)
    }
    console.timeEnd("reload middle")

    let entriesRemoved = false
    for (let [name, entry] of removedEntries) {
      entriesRemoved = true
      entry.destroy()

      if (this.entries.has(name)) {
        this.entries.delete(name)
      }

      if (this.expansionState.entries.has(name)) {
        this.expansionState.entries.delete(name)
      }
    }

    // Convert removedEntries to a Set containing only the entries for O(1) lookup
    if (entriesRemoved) {
      this.emitter.emit('did-remove-entries', new Set(removedEntries.values()))
    }

    if (newEntries.length > 0) {
      for (let entry of newEntries) {
        this.entries.set(entry.name, entry)
      }
      this.emitter.emit('did-add-entries', newEntries)
    }
    console.timeEnd("reload")
  }

  // Public: Collapse this directory and stop watching it.
  collapse () {
    this.expansionState.isExpanded = false
    this.expansionState = this.serializeExpansionState()
    this.unwatch()
    this.emitter.emit('did-collapse')
  }

  // Public: Expand this directory, load its children, and start watching it for
  // changes.
  expand () {
    this.expansionState.isExpanded = true
    this.reload()
    this.watch()
    this.emitter.emit('did-expand')
  }

  serializeExpansionState () {
    const expansionState = {}
    expansionState.isExpanded = this.expansionState.isExpanded
    expansionState.entries = new Map()
    for (let [name, entry] of this.entries) {
      if (entry.expansionState == null) break
      expansionState.entries.set(name, entry.serializeExpansionState())
    }
    return expansionState
  }

  squashDirectoryNames (fullPath) {
    const squashedDirs = [this.name]
    let contents
    while (true) {
      try {
        contents = fs.listSync(fullPath)
      } catch (error) {
        break
      }

      if (contents.length !== 1) break
      if (!fs.isDirectorySync(contents[0])) break
      const relativeDir = path.relative(fullPath, contents[0])
      squashedDirs.push(relativeDir)
      fullPath = path.join(fullPath, relativeDir)
    }

    if (squashedDirs.length > 1) {
      this.squashedNames = [squashedDirs.slice(0, squashedDirs.length - 1).join(path.sep) + path.sep, _.last(squashedDirs)]
    }

    return fullPath
  }
}
