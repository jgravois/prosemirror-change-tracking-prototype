const {Plugin, PluginKey} = require("prosemirror-state")
const {Transform} = require("prosemirror-transform")
const { Decoration, DecorationSet } = require('prosemirror-view')

const changeTrackingKey = new PluginKey('CHANGE_TRACKING_PLUGIN')

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
    this.decorations = DecorationSet.empty
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

  decorate() {
    const decos = []

    this.changes.forEach(change => {
      let deletedText = change.deletedText()
      if (deletedText) {
        const dom = document.createElement('span')
        dom.className = 'deleted'
        dom.innerHTML = deletedText

        const decoration = Decoration.widget(change.to, dom)
        decos.push(decoration)
      } else {
        const attrs = {
          class: 'inserted'
        }
        const decoration = Decoration.inline(change.from, change.to, attrs)
        decos.push(decoration)
      }
    })

    if (decos.length) {
      this.decorations = DecorationSet.create(this.state.doc, decos)
    } else {
      this.decorations = DecorationSet.empty
    }
  }

  forgetChange(change) {
    let found = this.changes.indexOf(change)
    if (found == -1) return false
    this.changes.splice(found, 1)
    return true
  }

  acceptChange(change) {
    if (this.forgetChange(change)) {
      this.decorate()
    }
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
    key: changeTrackingKey,
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
        changeTracking.decorate()
        return changeTracking
      },
      props: {
        changes (state) {
          return changeTracking.changes
        }
      }
    },
    props: {
      decorations (state) {
        return changeTracking.decorations
      }
    }
  })
}

module.exports = {
  TrackedChange,
  changeTrackingPlugin,
  changeTrackingKey
}
