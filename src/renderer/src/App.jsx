import React from 'react'
import { useSession } from './store/useSession.js'
import Home from './screens/Home.jsx'
import Recorder from './screens/Recorder.jsx'
import Editor from './screens/Editor.jsx'
import Export from './screens/Export.jsx'

export default function App() {
  const screen = useSession((s) => s.screen)

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-white overflow-hidden">
      <TitleBar />
      <main className="flex-1 overflow-hidden">
        {screen === 'home' && <Home />}
        {screen === 'record' && <Recorder />}
        {screen === 'editor' && <Editor />}
        {screen === 'export' && <Export />}
      </main>
    </div>
  )
}

function TitleBar() {
  const screen = useSession((s) => s.screen)
  const goto = useSession((s) => s.goto)
  const steps = [
    { id: 'home', label: 'Source' },
    { id: 'record', label: 'Record' },
    { id: 'editor', label: 'Edit' },
    { id: 'export', label: 'Export' }
  ]
  const idx = steps.findIndex((s) => s.id === screen)
  return (
    <div className="drag-region h-12 flex items-center justify-center px-4 border-b border-panel2 bg-panel relative">
      <div className="absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-2 no-drag">
        <span className="font-semibold tracking-tight">FocuClone</span>
        <span className="text-muted text-xs">personal</span>
      </div>
      <div className="flex items-center gap-1 no-drag">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1">
            <span
              className={`text-xs px-2 py-1 rounded ${
                i === idx
                  ? 'bg-accent text-black font-medium'
                  : i < idx
                  ? 'text-white/70'
                  : 'text-muted'
              }`}
            >
              {i + 1}. {s.label}
            </span>
            {i < steps.length - 1 && <span className="text-muted">›</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
