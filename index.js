const {Plugin, PluginKey} = require("prosemirror-state")
const {Transform} = require("prosemirror-transform")

class TrackedChange {
  constructor(from, to, deleted, author) {
    this.from = from
    this.to = to
    this.deleted = deleted
    this.author = author
  }

  map(mapping, inclusive) {
    let from = mapping.map(this.from, inclusive ? -1 : 1)
    let to = mapping.map(this.to, inclusive ? 1 : -1)
    if (from > to || from == to && !this.deleted.size) return null
    return new TrackedChange(from, to, this.deleted, this.author)
  }

  deletedText() {
    return this.deleted.content.textBetween(0, this.deleted.content.size, " ")
  }
}

function applyAndSlice(doc, changes, from, to) {
  let tr = new Transform(doc)
  for (let i = changes.length - 1; i >= 0; i--) {
    let change = changes[i]
    tr.replace(change.from, change.to, change.deleted)
  }
  return tr.doc.slice(from, tr.mapping.map(to))
}

function minimizeChange(change, doc, side) {
  let tr = new Transform(doc).replace(change.from, change.to, change.deleted)
  let changedDoc = tr.doc

  let $from = doc.resolve(change.from), sameDepth = $from.depth
  let $changedFrom = changedDoc.resolve(change.from), changeEnd = change.from + change.deleted.size
  while (change.to > $from.end(sameDepth) || changeEnd > $changedFrom.end(sameDepth)) --sameDepth

  let node = $from.node(sameDepth), changedNode = $changedFrom.node(sameDepth)

  if (side == -1) {
    let diffStart = node.content.findDiffStart(changedNode.content, $from.start(sameDepth))
    if (!diffStart) return null
    if (diffStart == change.from || diffStart >= change.to) return change
    return new TrackedChange(diffStart, change.to, changedDoc.slice(diffStart, tr.map(change.to)), change.author)
  } else {
    let diffEnd = node.content.findDiffEnd(changedNode.content, $from.end(sameDepth), $changedFrom.end(sameDepth))
    if (!diffEnd) return null
    if (diffEnd.a == change.to || diffEnd.a <= change.from || diffEnd.b <= change.from) return change
    return new TrackedChange(change.from, diffEnd.a, changedDoc.slice(change.from, diffEnd.b), change.author)
  }
}

function mapChanges(changes, map, author, updated, docAfter) {
  let result = []
  for (let i = 0; i < changes.length; i++) {
    let change = changes[i], mapped = change.map(map, author == change.author), idx
    if (mapped) {
      if (updated && (idx = updated.indexOf(change)) > -1)
        mapped = minimizeChange(mapped, docAfter, updated[idx + 1])
      if (mapped) result.push(mapped)
    }
  }
  return result
}

class ChangeTracking {
  constructor(state, options) {
    this.state = state
    this.changes = options.changes.slice()
    this.annotations = []
    this.author = options.author
  }

  record(transform, author) {
    let updated = []
    for (let i = 0; i < transform.steps.length; i++) {
      let map = transform.mapping.maps[i]
      for (let r = 0; r < map.ranges.length; r += 3)
        this.recordRange(transform.docs[i], map.ranges[r], map.ranges[r] + map.ranges[r + 1], author, updated)
      this.changes = mapChanges(this.changes, map, author, updated, transform.docs[i + 1] || transform.doc)
      updated.length = 0
    }
  }

  recordRange(doc, from, to, author, updatedChanges) {
    let i = 0
    for (; i < this.changes.length; i++) {
      let change = this.changes[i]
      if (change.author != author || change.to < from) continue
      if (change.from > to) break

      let changes = [change], newContent = from < change.from || to > change.to

      for (let j = i + 1; j < this.changes.length; j++) {
        let next = this.changes[j]
        if (next.author != author) continue
        if (next.from > to) break

        changes.push(next)
        newContent = true
        this.changes.splice(j--, 1)
      }

      let newFrom = Math.min(change.from, from), newTo = Math.max(changes[changes.length - 1].to, to)
      let slice = newContent ? applyAndSlice(doc, changes, newFrom, newTo) : change.deleted
      updatedChanges.push(this.changes[i] = new TrackedChange(newFrom, newTo, slice, change.author),
                          from <= changes[0].from ? -1 : 1)
      return
    }
    this.changes.splice(i, 0, new TrackedChange(from, to, doc.slice(from, to), author))
  }

  updateAnnotations() {
    // See if our document annotations still match the set of changes,
    // and update them if they don't.
    let iA = 0
    for (let iC = 0; iC < this.changes.length; iC++) {
      let change = this.changes[iC], matched = false
      let deletedText = change.deletedText()
      while (iA < this.annotations.length) {
        let ann = this.annotations[iA]
        if (ann.from > change.to) break
        if (ann.from == change.from && ann.to == change.to && ann.options.deletedText == deletedText) {
          iA++
          matched = true
        } else {
          this.state.removeRange(ann)
          this.annotations.splice(iA, 1)
        }
      }
      if (!matched) {
        // not sure what the modern alternative to markRange is
        // let ann = this.state.markRange(change.from, change.to, rangeOptionsFor(change, deletedText))
        // this.annotations.splice(iA++, 0, ann)
      }
    }
    for (let i = iA; i < this.annotations.length; i++) {
      this.state.removeRange(this.annotations[iA])
    }
    this.annotations.length = iA
  }

  forgetChange(change) {
    let found = this.changes.indexOf(change)
    if (found == -1) return false
    this.changes.splice(found, 1)
    return true
  }

  acceptChange(change) {
    if (this.forgetChange(change))
      this.updateAnnotations()
  }

  revertChange(change) {
    if (this.forgetChange(change)) {
      const transaction = this.state.tr.replace(change.from, change.to, change.deleted)

      // how to pass through config options to the plugins apply() handler?
      this.state.apply(transaction, {
        scrollIntoView: true,
        reverting: true,
        addToHistory: false
      })
    }
  }
}

function changeTrackingPlugin () {
  let changeTracking
  return new Plugin({
    key: new PluginKey('CHANGE_TRACKING_PLUGIN'),
    state: {
      init (config, state) {
        changeTracking = new ChangeTracking(state, { author: 'x', changes: [] })
        return changeTracking
      },
      apply (transform, oldState, newState, options) {
        // FIXME split changes when typing inside them?
        if (!changeTracking.author || options.reverting) {
          changeTracking.changes = mapChanges(changeTracking.changes, transform)
        }
        else {
          changeTracking.record(transform, changeTracking.author)
        }
        // still broken
        changeTracking.updateAnnotations()
        return changeTracking
      },
      props: {
        changes (state) {
          debugger
          return changeTracking.changes
        }
      }
    }
  })
}

function rangeOptionsFor(change, deletedText) {
  let options = {}
  if (change.from == change.to) options.removeWhenEmpty = false
  else options.className = "inserted"
  if (deletedText) {
    options.deletedText = deletedText
    let elt = options.elementBefore = document.createElement("span")
    elt.textContent = deletedText
    elt.className = "deleted"
  }
  return options
}

module.exports = { TrackedChange, changeTrackingPlugin }
