import React from 'react'
import { useSession } from './store/useSession.js'
import Home from './screens/Home.jsx'
import Recorder from './screens/Recorder.jsx'
import Editor from './screens/Editor.jsx'
import Export from './screens/Export.jsx'

const STEPS = [
  { id: 'home', label: 'Source' },
  { id: 'record', label: 'Record' },
  { id: 'editor', label: 'Edit' },
  { id: 'export', label: 'Export' }
]

export default function App() {
  const screen = useSession((s) => s.screen)

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-1)' }}>
      <TitleBar />
      <Stepper />
      <main className="flex-1 overflow-hidden flex flex-col min-h-0">
        {screen === 'home' && <Home />}
        {screen === 'record' && <Recorder />}
        {screen === 'editor' && <Editor />}
        {screen === 'export' && <Export />}
      </main>
    </div>
  )
}

function TitleBar() {
  return (
    <div className="titlebar drag-region">
      <div />
      <div className="title-center">
        <span className="brand-mark"><BrandLogo /></span>
        <span className="brand-name">FocuClone</span>
      </div>
      <div className="title-right" />
    </div>
  )
}

function BrandLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 4h5M4 4v5M20 4h-5M20 4v5M4 20h5M4 20v-5M20 20h-5M20 20v-5"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.2" fill="#FF5C2B" />
    </svg>
  )
}

function Stepper() {
  const screen = useSession((s) => s.screen)
  const goto = useSession((s) => s.goto)
  const session = useSession((s) => s.session)
  const source = useSession((s) => s.source)

  const currentIdx = STEPS.findIndex((s) => s.id === screen)

  // Available steps depend on app state to avoid breaking flow:
  // - Source: always available
  // - Record: needs source picked
  // - Edit:   needs a finalised session
  // - Export: needs a finalised session
  function isAvailable(id, idx) {
    if (id === 'home') return true
    if (id === 'record') return !!source
    if (id === 'editor') return !!session
    if (id === 'export') return !!session
    return idx <= currentIdx
  }

  return (
    <div className="stepper">
      {STEPS.map((s, i) => {
        const state =
          i === currentIdx ? 'current' : i < currentIdx ? 'done' : 'todo'
        const available = isAvailable(s.id, i)
        const onClick = () => available && s.id !== screen && goto(s.id)
        return (
          <React.Fragment key={s.id}>
            <button
              className={`step ${state === 'current' ? 'step-current' : ''} ${
                state === 'done' ? 'step-done' : ''
              }`}
              disabled={!available}
              onClick={onClick}
            >
              <span className="step-dot">
                {state === 'done' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span>{s.label}</span>
            </button>
            {i < STEPS.length - 1 && (
              <span className={`step-line ${i < currentIdx ? 'on' : ''}`} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
