const {DOMParser} =require("prosemirror-model")
const {EditorState} = require("prosemirror-state")
const {EditorView} = require("prosemirror-view")
const {schema} = require("prosemirror-schema-basic")
const {changeTrackingPlugin} = require("./index")

let state = EditorState.create({
  doc: DOMParser.fromSchema(schema).parse(document.querySelector("#content")),
  schema,
  plugins: [ changeTrackingPlugin() ] // changeTracking.config({author: "x"})]
})
let pm = window.pm = new EditorView(document.body, {state})

let tracking = { changes: [] } // window.tracking = view.changeTracking.get(window.pm)

const controls = document.body.appendChild(document.createElement("div"))

function updateControls() {
  controls.textContent = ""
  tracking.changes.forEach(change => {
    let div = controls.appendChild(document.createElement("div"))
    div.className = "change"
    div.appendChild(document.createElement("strong")).appendChild(document.createTextNode(change.author))
    let deleted = change.deletedText(), added = pm.doc.textBetween(change.from, change.to, " ")
    let desc = deleted ? " deleted " + JSON.stringify(deleted) : ""
    if (added) desc += (desc ? " and" : "") + " added " + JSON.stringify(added)
    div.appendChild(document.createTextNode(desc))
    div.appendChild(document.createElement("br"))
    let commit = div.appendChild(document.createElement("button"))
    commit.textContent = "Accept"
    commit.addEventListener("click", e => {
      e.preventDefault()
      tracking.acceptChange(change)
      updateControls()
    })
    div.appendChild(document.createTextNode(" "))
    let revert = div.appendChild(document.createElement("button"))
    revert.textContent = "Revert"
    revert.addEventListener("click", e => {
      e.preventDefault()
      tracking.revertChange(change)
    })
  })
}

updateControls()
// pm.on.change.add(() => setTimeout(updateControls, 50))
