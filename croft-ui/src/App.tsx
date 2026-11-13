import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlignLeft, ArrowLeft, ArrowRight, ArrowUpRight, Bell, Bold, BookOpen, CalendarDays,
  Check, ChevronDown, ChevronRight, ClipboardList, Code, Ellipsis,
  FileText, Folders, GripVertical, Heading1, Heading2, House, Image, Inbox, Italic, LayoutGrid, Lightbulb,
  Link2, List, ListChecks, ListOrdered, MessageSquare, Monitor, Moon, PanelLeft, Plus, Quote,
  Search, Settings, Settings2, Star, Sun, Table2, Trash2, Type, Underline, X,
} from 'lucide-react'
import { Database, type DatabaseView } from './Database'
import { CanvasWorkspace } from './features/icanvas/CanvasWorkspace'
import { CanvasBackupDialog } from './features/icanvas/CanvasBackupDialog'
import { CanvasDialog, ProjectCards, ProjectTree, ProjectDetails, ProjectIcon } from './features/icanvas/ProjectViews'
import { ancestors, createProject, searchCanvasObjects, type CanvasProject, type CardSide } from './features/icanvas/model'
import { useCanvasProjects } from './features/icanvas/useCanvasProjects'

type Page = 'home' | 'handbook' | 'weekly' | 'meeting' | 'projects'
type Overlay = 'search' | 'inbox' | 'settings' | 'archive' | 'about' | 'new' | null
type Theme = 'light' | 'dark' | 'system'
const pages = {
  home: { name: 'Home', icon: House, colour: 'sage', location: 'Croft' },
  handbook: { name: 'Studio handbook', icon: BookOpen, colour: 'sand', location: 'Studio' },
  weekly: { name: 'Weekly studio notes', icon: FileText, colour: 'lavender', location: 'Studio handbook' },
  meeting: { name: 'Meeting notes', icon: MessageSquare, colour: 'pink', location: 'Studio handbook' },
  projects: { name: 'Projects', icon: Table2, colour: 'blue', location: 'Studio' },
}
const pageIds = Object.keys(pages) as Page[]
const quickPages: { id: Page; description: string }[] = [
  { id: 'projects', description: 'Active work, owners and timelines' },
  { id: 'handbook', description: 'How we work at Fieldwork' },
  { id: 'weekly', description: 'Updates from the studio' },
]
const recent: { id: Page; time: string }[] = [
  { id: 'handbook', time: 'Today, 10:42' },
  { id: 'projects', time: 'Today, 09:15' },
  { id: 'weekly', time: 'Yesterday' },
  { id: 'meeting', time: '10 Nov' },
]
const views = ['table', 'board', 'calendar', 'gallery', 'list']
const themes: { id: Theme; name: string; icon: typeof Sun }[] = [
  { id: 'system', name: 'System', icon: Monitor }, { id: 'light', name: 'Light', icon: Sun }, { id: 'dark', name: 'Dark', icon: Moon },
]

function route() {
  const [id, tab] = location.hash.slice(1).split('/')
  return {
    page: pageIds.includes(id as Page) ? id as Page : 'home' as Page,
    view: (views.includes(tab) ? tab : 'table') as DatabaseView,
    canvasId: id === 'canvas' ? tab || '' : '',
  }
}

function Mark({ className = '' }: { className?: string }) {
  return <img className={'mark ' + className} src="/croft-mark.png" alt="Croft" />
}

function PageIcon({ id, tile = false }: { id: Page; tile?: boolean }) {
  const { icon: Icon, colour } = pages[id]
  return <span className={tile ? 'page-icon tile ' + colour : 'page-icon'}><Icon aria-hidden="true" /></span>
}

function Modal({ className = '', label, close, children }: { className?: string; label: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])
  return (
    <dialog className={'modal ' + className} aria-label={label} ref={dialog}
      onClick={event => { if (event.target === event.currentTarget) close() }}
      onCancel={event => { event.preventDefault(); close() }}>
      <div className="modal-content">{children}</div>
    </dialog>
  )
}

function Home({ go, children }: { go: (page: Page) => void; children?: ReactNode }) {
  return (
    <article className="home" aria-labelledby="home-heading">
      <header className="home-title">
        <span className="home-mark" aria-hidden="true"><Mark /></span>
        <h1 id="home-heading">Croft</h1>
        <p>Space to grow.</p>
      </header>
      {children}
      <section className="home-section" aria-labelledby="home-recent">
        <h2 id="home-recent">Recently visited</h2>
        <ul className="recent-list">
          {recent.map(item => <li key={item.id}>
            <button onClick={() => go(item.id)} className="recent-row">
              <PageIcon id={item.id} />
              <span className="recent-page">{pages[item.id].name}</span>
              <span className="recent-time">{item.time}</span>
            </button>
          </li>)}
        </ul>
      </section>
    </article>
  )
}

const slashGroups = [
  { name: 'Basic blocks', commands: [
    { label: 'Text', icon: Type, hint: 'Plain text' }, { label: 'Heading 1', icon: Heading1, hint: '#' },
    { label: 'Heading 2', icon: Heading2, hint: '##' }, { label: 'Bulleted list', icon: List, hint: '-' },
    { label: 'Numbered list', icon: ListOrdered, hint: '1.' }, { label: 'To-do list', icon: ListChecks, hint: '[]' },
    { label: 'Callout', icon: Lightbulb, hint: '' }, { label: 'Quote', icon: Quote, hint: '' },
  ] },
  { name: 'Media', commands: [{ label: 'Image', icon: Image, hint: '' }, { label: 'Code', icon: Code, hint: '' }] },
]

function FormattingToolbar({ close }: { close: () => void }) {
  return <div className="format-toolbar popover" role="toolbar" aria-label="Text formatting preview">
    <button className="format-type" onClick={close}>Text <ChevronDown /></button>
    <i />
    {[{ icon: Bold, name: 'Bold' }, { icon: Italic, name: 'Italic' }, { icon: Underline, name: 'Underline' },
      { icon: Code, name: 'Inline code' }, { icon: Link2, name: 'Link' }, { icon: MessageSquare, name: 'Comment' }].map(({ icon: Icon, name }) =>
        <button className="icon-button" key={name} aria-label={name} title={name} onClick={close}><Icon /></button>)}
  </div>
}

function Document({ page, go, editorState, setEditorState }: {
  page: 'handbook' | 'weekly' | 'meeting'; go: (id: Page) => void;
  editorState: 'slash' | 'format' | null; setEditorState: (state: 'slash' | 'format' | null) => void
}) {
  const [filter, setFilter] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editorState === 'slash') { setFilter(''); searchRef.current?.focus() } }, [editorState])
  return (
    <article className="document">
      {page === 'handbook' && <div className="document-cover"><img src="/fieldwork-cover.webp" alt="Coastal dunes" /></div>}
      <div className={'document-inner ' + (page === 'handbook' ? 'with-cover' : '')}>
        <PageIcon id={page} tile />
        <h1>{pages[page].name}</h1>
        <div className="doc-byline"><span className="avatar">AM</span> Alex Morgan <span className="byline-dot" /> Updated 12 November</div>
        {page === 'handbook' ? <>
          <div className="doc-callout"><Lightbulb /><span><strong>Welcome to Fieldwork.</strong> This handbook is the starting point for working together, finding what you need, and keeping projects moving.</span></div>
          <h2>How we work</h2>
          <p>We’re an independent design studio working at the intersection of identity, digital products and editorial. Our work begins with close observation and gets better through open feedback.</p>
          <div className="editable-example">
            <p>Keep decisions close to the work. <button className={editorState === 'format' ? 'selected-text' : 'select-text'}
              onClick={() => setEditorState(editorState === 'format' ? null : 'format')}>Write down what changed and why.</button></p>
            {editorState === 'format' && <FormattingToolbar close={() => setEditorState(null)} />}
          </div>
          <h2>Inside the handbook</h2>
          <div className="child-pages">
            <button onClick={() => go('weekly')}><PageIcon id="weekly" /> Weekly studio notes <ArrowRight /></button>
            <button onClick={() => go('meeting')}><PageIcon id="meeting" /> Meeting notes <ArrowRight /></button>
            <button onClick={() => go('projects')}><PageIcon id="projects" /> Projects <ArrowRight /></button>
          </div>
        </> : page === 'weekly' ? <>
          <div className="doc-callout"><CalendarDays /><span><strong>Week of 9 November.</strong> Notes from our Friday studio catch-up.</span></div>
          <h2>Project updates</h2>
          <ul><li>Atlas: two identity routes are ready for review.</li><li>Meridian: page templates are with the editorial team.</li><li>Northline: component inventory starts on Monday.</li></ul>
          <h2>For next week</h2>
          <div className="doc-task"><Check /> Share the Atlas deck before Thursday</div>
          <div className="doc-task"><span /> Pull together references for the editorial shoot</div>
          <button className="doc-back" onClick={() => go('handbook')}><ArrowLeft /> Studio handbook</button>
        </> : <>
          <div className="doc-callout"><MessageSquare /><span><strong>Studio planning · 10 November.</strong> Alex, Mina and Jamie.</span></div>
          <h2>Decisions</h2>
          <ul><li>Use the warmer palette for the Atlas design review.</li><li>Keep the first Meridian issue to 24 pages.</li><li>Book the next working session for Monday morning.</li></ul>
          <h2>Follow-up</h2>
          <p>Mina will share the updated type samples. Jamie will add the review notes to the project table.</p>
          <button className="doc-back" onClick={() => go('handbook')}><ArrowLeft /> Studio handbook</button>
        </>}
        <div className="mock-block">
          <div className="block-gutter"><button className="icon-button" aria-label="Open slash command preview" title="Show commands" onClick={() => setEditorState(editorState === 'slash' ? null : 'slash')}><Plus /></button><GripVertical /></div>
          <button className="slash-trigger" onClick={() => setEditorState(editorState === 'slash' ? null : 'slash')}>Type ‘/’ for commands</button>
          {editorState === 'slash' && <div className="slash-menu popover">
            <input aria-label="Find a block" placeholder="Search commands…" ref={searchRef} value={filter} onChange={e => setFilter(e.target.value)} />
            <div className="slash-options">
              {slashGroups.map(({ name, commands }) => {
                const matches = commands.filter(command => command.label.toLowerCase().includes(filter.toLowerCase()))
                return matches.length ? <div key={name}><h3>{name}</h3>{matches.map(({ label, icon: Icon, hint }) =>
                  <button key={label} onClick={() => setEditorState(null)}><span className="slash-icon"><Icon /></span>{label}<small>{hint}</small></button>)}</div> : null
              })}
            </div>
            <footer>Close menu <kbd>Esc</kbd></footer>
          </div>}
        </div>
      </div>
    </article>
  )
}

function SearchModal({ close, go, projects, openCanvas }: {
  close: () => void; go: (page: Page) => void; projects: CanvasProject[]
  openCanvas: (id: string, objectId?: string, side?: CardSide) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const term = query.trim().toLowerCase()
  const options: { id: string; title: string; location: string; icon: ReactNode; description: string; open: () => void }[] =
    (term ? pageIds : recent.map(item => item.id)).filter(id => pages[id].name.toLowerCase().includes(term)).map(id => ({
    id, title: pages[id].name, location: pages[id].location,
    icon: <PageIcon id={id} tile />, description: quickPages.find(entry => entry.id === id)?.description || 'Notes and decisions from the studio.',
    open: () => go(id),
  }))
  if (term) for (const project of projects) {
    if ((project.name + ' ' + project.description).toLowerCase().includes(term)) options.push({
      id: project.id, title: project.name, location: 'iCanvas', description: project.description,
      icon: <span className="page-icon tile sage"><ProjectIcon project={project} /></span>, open: () => openCanvas(project.id),
    })
    for (const match of searchCanvasObjects(project, term)) {
      options.push({
        id: `${project.id}/${match.object.id}/${match.side ?? ''}`, title: match.title, location: match.location, description: match.description,
        icon: <span className="page-icon tile sage"><FileText /></span>, open: () => openCanvas(project.id, match.object.id, match.side),
      })
      if (options.length >= 60) break
    }
    if (options.length >= 60) break
  }
  const item = options[selected]
  return <Modal className="search-modal" label="Search workspace" close={close}>
    <div className="search-modal-top">
      <Search />
      <input autoFocus placeholder="Search Croft…" aria-label="Search pages" value={query}
        onChange={e => { setQuery(e.target.value); setSelected(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setSelected(last => Math.max(0, Math.min(options.length - 1, last + (e.key === 'ArrowDown' ? 1 : -1))))
          }
          if (e.key === 'Enter' && item) item.open()
        }} />
      <button className="icon-button" onClick={close} aria-label="Close search"><X /></button>
    </div>
    <div className="search-filters"><span>All pages <ChevronDown /></span><span>Sort <ChevronDown /></span></div>
    <div className="search-columns">
      <div className="search-results">
        <h2>{query ? 'Results' : 'Recently visited'}</h2>
        {options.map((result, index) => <button key={result.id} data-active={index === selected} onMouseEnter={() => setSelected(index)} onClick={result.open}>
          {result.icon}<span><strong>{result.title}</strong><small>{result.location}</small></span><ArrowUpRight />
        </button>)}
        {!options.length && <p>No pages match this search.</p>}
      </div>
      <div className="search-preview">{item && <>
        {item.icon}<h2>{item.title}</h2><p>{item.description}</p>
        <span className="paper-line" /><span className="paper-line short" /><span className="paper-line" />
      </>}</div>
    </div>
    <footer className="search-modal-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
  </Modal>
}

const preferences = [
  { name: 'Preferences', icon: Settings2 }, { name: 'Notifications', icon: Bell },
  { name: 'Language & time', icon: CalendarDays }, { name: 'General', icon: Folders },
] as const

function SettingsModal({ close, theme, setTheme, openAbout }: {
  close: () => void; theme: Theme; setTheme: (theme: Theme) => void; openAbout: () => void
}) {
  const [category, setCategory] = useState<string>('Preferences')
  const [picker, setPicker] = useState(false)
  const current = themes.find(item => item.id === theme) ?? themes[0]
  return <Modal className="settings-modal" label="Workspace settings" close={close}>
    <aside className="settings-nav">
      <div className="settings-person"><span className="workspace-badge"><Mark /></span><strong>Croft</strong></div>
      <h2>Personal</h2>
      {preferences.slice(0, 3).map(({ name, icon: Icon }) =>
        <button key={name} data-active={category === name} onClick={() => { setPicker(false); setCategory(name) }}><Icon />{name}</button>)}
      <h2>Workspace</h2>
      <button data-active={category === 'General'} onClick={() => { setPicker(false); setCategory('General') }}><Folders /> General</button>
    </aside>
    <div className="settings-main">
      <button className="icon-button modal-close" aria-label="Close settings" onClick={close}><X /></button>
      <h1>{category}</h1>
      {category === 'Preferences' ? <>
        <div className="setting-row">
          <div><h3>Appearance</h3><p>Choose how Croft looks on this device.</p></div>
          <div className="setting-picker">
            <button className="quiet-button" aria-expanded={picker} onClick={() => setPicker(!picker)}><current.icon /> {current.name} <ChevronDown /></button>
            {picker && <div className="popover theme-menu">
              {themes.map(({ id, name, icon: Icon }) => <button key={id} onClick={() => { setTheme(id); setPicker(false) }}>
                <Icon /> {name} {theme === id && <Check className="menu-check" />}
              </button>)}
            </div>}
          </div>
        </div>
        <div className="setting-row"><div><h3>Open on start</h3><p>Choose the page shown when the workspace opens.</p></div><span className="setting-value">Home <ChevronDown /></span></div>
        <div className="setting-row"><div><h3>Spell check</h3><p>Show spelling suggestions in pages.</p></div><span className="sample-switch" aria-label="On" /></div>
        <div className="setting-row"><div><h3>Page width</h3><p>Default reading width for documents.</p></div><span className="setting-value">Default <ChevronDown /></span></div>
      </> : category === 'Notifications' ? <>
        <div className="setting-row"><div><h3>Workspace activity</h3><p>Comments and mentions in this workspace.</p></div><span className="sample-switch" aria-label="On" /></div>
        <div className="setting-row"><div><h3>Project reminders</h3><p>Reminders for scheduled project dates.</p></div><span className="sample-switch off" aria-label="Off" /></div>
      </> : category === 'Language & time' ? <>
        <div className="setting-row"><div><h3>Language</h3><p>Display language for workspace menus.</p></div><span className="setting-value">English (UK) <ChevronDown /></span></div>
        <div className="setting-row"><div><h3>Time zone</h3><p>Calendar and reminder time zone.</p></div><span className="setting-value">Europe/London <ChevronDown /></span></div>
        <div className="setting-row"><div><h3>Start week on Monday</h3><p>Apply to workspace calendars.</p></div><span className="sample-switch" aria-label="On" /></div>
      </> : <>
        <div className="setting-row"><div><h3>Workspace name</h3><p>The name shown in the sidebar.</p></div><span className="setting-value">Croft</span></div>
        <div className="setting-row"><div><h3>Workspace icon</h3><p>The Croft geometric C mark.</p></div><span className="settings-mark"><Mark /></span></div>
        <div className="setting-row"><div><h3>Croft</h3><p>Space to grow.</p></div><button className="quiet-button" onClick={openAbout}>About Croft</button></div>
      </>}
    </div>
  </Modal>
}

function EmptyDialog({ label, message, icon: Icon, close }: {
  label: string; message: string; icon: typeof Inbox; close: () => void
}) {
  return <Modal className="empty-dialog" label={label} close={close}>
    <header className="empty-dialog-header">
      <h2>{label}</h2>
      <button className="icon-button" aria-label={'Close ' + label} onClick={close}><X /></button>
    </header>
    <div className="empty-dialog-body"><Icon aria-hidden="true" /><p>{message}</p></div>
  </Modal>
}

export function App() {
  const canvases = useCanvasProjects()
  const canEdit = canvases.access === 'writer'
  const [draftCanvas, setDraftCanvas] = useState<CanvasProject | null>(null)
  const [showBackup, setShowBackup] = useState(false)
  const [jump, setJump] = useState<{ id: string; event: number; side?: CardSide }>()
  const [current, setCurrent] = useState(route)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [menu, setMenu] = useState<'page' | 'share' | null>(null)
  const [theme, setTheme] = useState<Theme>('light')
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [treeOpen, setTreeOpen] = useState(true)
  const [sidebar, setSidebar] = useState(() => innerWidth >= 800)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const focusSidebarToggle = useRef(false)
  const [editorState, setEditorState] = useState<'slash' | 'format' | null>(null)
  const [starred, setStarred] = useState<Page[]>(['handbook', 'projects'])
  const { page, view, canvasId } = current
  const activeCanvases = canvases.projects.filter(project => !ancestors(canvases.projects, project.id).some(item => item.trashedAt))
  const canvas = activeCanvases.find(project => project.id === canvasId)
  const trashedCanvases = canvases.projects.filter(project => project.trashedAt)
  const sidebarBeforeCanvas = useRef<boolean | null>(null)
  const dark = theme === 'dark' || theme === 'system' && systemDark

  function go(next: Page, databaseView: DatabaseView = 'table') {
    location.hash = next === 'projects' ? 'projects/' + databaseView : next
    setCurrent({ page: next, view: databaseView, canvasId: '' })
    setOverlay(null)
    setMenu(null)
    setEditorState(null)
    if (innerWidth < 800) setSidebar(false)
  }

  function openCanvas(id: string, objectId?: string, side?: CardSide) {
    setJump(objectId ? { id: objectId, side, event: performance.now() } : undefined)
    location.hash = 'canvas/' + id
    setCurrent({ page: 'home', view: 'table', canvasId: id })
    setOverlay(null)
    setMenu(null)
  }

  useEffect(() => {
    if (canvasId && sidebarBeforeCanvas.current === null) {
      sidebarBeforeCanvas.current = sidebar
      setSidebar(false)
    } else if (!canvasId && sidebarBeforeCanvas.current !== null) {
      setSidebar(sidebarBeforeCanvas.current)
      sidebarBeforeCanvas.current = null
    }
  }, [canvasId, sidebar])

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const changeTheme = () => setSystemDark(media.matches)
    const changeRoute = () => { setCurrent(route()); setEditorState(null) }
    media.addEventListener('change', changeTheme)
    addEventListener('hashchange', changeRoute)
    return () => { media.removeEventListener('change', changeTheme); removeEventListener('hashchange', changeRoute) }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  useEffect(() => {
    if (focusSidebarToggle.current) {
      sidebarToggleRef.current?.focus()
      focusSidebarToggle.current = false
    }
  }, [sidebar])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && ['k', 'p'].includes(event.key.toLowerCase()) && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault()
        setMenu(null)
        setOverlay('search')
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setTheme(dark ? 'light' : 'dark')
      }
      if (event.key === '/' && !canvasId && !overlay && page !== 'projects' && page !== 'home' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        setEditorState('slash')
        document.querySelector('.mock-block')?.scrollIntoView({ block: 'nearest' })
      }
      if (event.key === 'Escape') { setMenu(null); setEditorState(null) }
    }
    addEventListener('keydown', keydown)
    return () => removeEventListener('keydown', keydown)
  }, [overlay, page, dark, canvasId])

  const openOverlay = (next: Overlay) => { setMenu(null); setOverlay(next) }
  const closeOverlay = () => setOverlay(null)
  const toggleSidebar = () => {
    focusSidebarToggle.current = true
    setSidebar(open => !open)
  }
  const toggleMenu = (next: typeof menu) => setMenu(menu === next ? null : next)
  const toggleStar = () => setStarred(items => items.includes(page) ? items.filter(id => id !== page) : [...items, page])
  const sidebarLink = (id: Page, indent = false) => (
    <button key={id} className={'side-link ' + (indent ? 'indented' : '')} aria-current={id === page ? 'page' : undefined} onClick={() => go(id)}>
      <PageIcon id={id} /><span>{pages[id].name}</span>
    </button>
  )

  return <div className="shell" data-sidebar={sidebar ? 'open' : 'closed'}>
    {sidebar && <>
      <button className="mobile-scrim" aria-label="Dismiss sidebar" tabIndex={-1} onClick={toggleSidebar} />
      <aside id="workspace-sidebar" className="sidebar" aria-label="Workspace sidebar">
        <div className="sidebar-header">
          <span className="workspace-badge"><Mark /></span>
          <strong>Croft</strong>
          <button ref={sidebarToggleRef} className="icon-button collapse-sidebar" title="Collapse sidebar" aria-label="Collapse sidebar"
            aria-expanded="true" aria-controls="workspace-sidebar" onClick={toggleSidebar}><PanelLeft /></button>
        </div>
        <nav className="primary-nav" aria-label="Workspace navigation">
          <div className="nav-group">
            <button className="side-link" data-active={overlay === 'search'} aria-haspopup="dialog" onClick={() => openOverlay('search')}>
              <Search /><span>Search</span><kbd aria-hidden="true">Ctrl K</kbd>
            </button>
            <button className="side-link" aria-current={page === 'home' && !canvasId ? 'page' : undefined} onClick={() => go('home')}>
              <House /><span>Home</span>
            </button>
            <button className="side-link" data-active={overlay === 'inbox'} aria-haspopup="dialog" onClick={() => openOverlay('inbox')}>
              <Inbox /><span>Inbox</span>
            </button>
          </div>
          <div className="nav-group rail-footer">
            <button className="side-link" data-active={overlay === 'settings'} aria-haspopup="dialog" onClick={() => openOverlay('settings')}>
              <Settings /><span>Settings</span>
            </button>
            <button className="side-link" data-active={overlay === 'archive'} aria-haspopup="dialog" onClick={() => openOverlay('archive')}>
              <Trash2 /><span>Trash</span>
            </button>
          </div>
        </nav>
        <ProjectTree projects={activeCanvases} current={canvasId} open={openCanvas} />
        <div className="sidebar-scroll" hidden>
          <section className="rail-group">
            <div className="rail-label">Favourites</div>
            {starred.filter(id => id !== 'home').map(id => sidebarLink(id))}
          </section>
          <section className="rail-group">
            <div className="rail-label">Workspace <button className="icon-button" aria-label="New page preview" onClick={() => openOverlay('new')}><Plus /></button></div>
            <div className="tree-parent">
              <button className="tree-disclosure icon-button" title={treeOpen ? 'Collapse pages' : 'Expand pages'} aria-label={treeOpen ? 'Collapse handbook' : 'Expand handbook'}
                aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>{treeOpen ? <ChevronDown /> : <ChevronRight />}</button>
              {sidebarLink('handbook')}
            </div>
            {treeOpen && <div className="tree-children">{sidebarLink('weekly', true)}{sidebarLink('meeting', true)}</div>}
            {sidebarLink('projects')}
            <button className="side-link side-new" onClick={() => openOverlay('new')}><Plus /><span>New page</span></button>
          </section>
        </div>
      </aside>
    </>}
    <main className="workspace-main">
      {canvases.access === 'readonly' && <div className="ic-access-banner" role="status">
        <span><strong>Read-only.</strong> {canvases.accessReason || 'Close the other editing tab, then enable editing here to load the latest saved work.'}</span>
        <button className="ic-button" onClick={() => void canvases.requestEditing()}>Enable editing</button>
      </div>}
      {canvas ? <CanvasWorkspace key={canvas.id} project={canvas} store={canvases} sidebarOpen={sidebar}
        sidebarToggleRef={sidebarToggleRef} toggleSidebar={toggleSidebar} openCanvas={openCanvas} goHome={() => go('home')}
        openPage={id => go(pageIds.includes(id as Page) ? id as Page : 'home')} jump={jump} dark={dark} /> :
      canvasId ? <div className="ic-route-message">{canvases.status === 'Loading' ? 'Opening canvas…' : canvases.error || 'Canvas unavailable.'}
        <button className="quiet-button" onClick={() => go('home')}>Home</button></div> : <>
      <header className="topbar">
        <div className="topbar-start">
          {!sidebar && <button ref={sidebarToggleRef} className="icon-button side-toggle" title="Open sidebar" aria-label="Open sidebar"
            aria-expanded="false" onClick={toggleSidebar}><PanelLeft /></button>}
          {page !== 'home' && <>
            <button className="icon-button history-arrow" title="Back" aria-label="Back" onClick={() => history.back()}><ArrowLeft /></button>
            <button className="icon-button history-arrow" title="Forward" aria-label="Forward" onClick={() => history.forward()}><ArrowRight /></button>
            <span className="topbar-separator" />
          </>}
          <nav className="crumbs" aria-label="Breadcrumbs">
            {page !== 'home' && <><button onClick={() => go('home')}>Croft</button><ChevronRight /></>}
            {(page === 'weekly' || page === 'meeting') && <><button onClick={() => go('handbook')}>Studio handbook</button><ChevronRight /></>}
            <span aria-current="page"><PageIcon id={page} />{pages[page].name}</span>
          </nav>
        </div>
        {page !== 'home' && <div className="topbar-end">
          <button className="top-share" aria-expanded={menu === 'share'} onClick={() => toggleMenu('share')}>Share</button>
          <button className="icon-button" aria-pressed={starred.includes(page)} aria-label="Toggle favourite" title="Favourite" onClick={toggleStar}><Star /></button>
          <button className="icon-button" aria-label="Page options" aria-expanded={menu === 'page'} onClick={() => toggleMenu('page')}><Ellipsis /></button>
          {menu === 'page' && <div className="popover top-menu">
            <button onClick={() => { toggleStar(); setMenu(null) }}><Star /> {starred.includes(page) ? 'Remove from favourites' : 'Add to favourites'}</button>
            {page !== 'projects' && <>
              <button onClick={() => { setEditorState('slash'); setMenu(null); requestAnimationFrame(() => document.querySelector('.mock-block')?.scrollIntoView({ block: 'center' })) }}><Plus /> Slash commands</button>
              <button onClick={() => { setEditorState('format'); setMenu(null); requestAnimationFrame(() => document.querySelector('.editable-example')?.scrollIntoView({ block: 'center' })) }}><AlignLeft /> Formatting toolbar</button>
            </>}
            <button onClick={() => openOverlay('settings')}><Settings2 /> Settings</button>
          </div>}
          {menu === 'share' && <div className="popover small-preview"><h3>Share page</h3><div><span className="avatar">AM</span> Alex Morgan <small>Owner</small></div><p>Only you have access to this sample page.</p></div>}
        </div>}
      </header>
      <div className="workspace-scroll" key={page}>
        {page === 'home' ? <Home go={go}><ProjectCards projects={activeCanvases} create={() => setDraftCanvas(createProject(''))}
          open={openCanvas} details={setDraftCanvas} importProjects={canvases.write} error={canvases.error} canEdit={canEdit}
          openBackup={() => setShowBackup(true)} /></Home> :
          page === 'projects' ? <Database view={view} onView={tab => { location.hash = 'projects/' + tab; setCurrent({ page, view: tab, canvasId: '' }) }} /> :
          <Document key={page} page={page} go={go} editorState={editorState} setEditorState={setEditorState} />}
      </div>
      </>}
    </main>
    {overlay === 'inbox' && <EmptyDialog label="Inbox" message="You’re all caught up." icon={Inbox} close={closeOverlay} />}
    {overlay === 'search' && <SearchModal close={closeOverlay} go={go} projects={activeCanvases} openCanvas={openCanvas} />}
    {showBackup && <CanvasBackupDialog close={() => setShowBackup(false)} flush={canvases.flush} canRestore={canEdit} />}
    {draftCanvas && canEdit && <ProjectDetails project={draftCanvas} close={() => setDraftCanvas(null)}
      onSave={async (project, assets) => {
        await canvases.write([project], assets)
        setDraftCanvas(null)
        openCanvas(project.id)
      }} />}
    {overlay === 'settings' && <SettingsModal close={closeOverlay} theme={theme} setTheme={setTheme} openAbout={() => openOverlay('about')} />}
    {overlay === 'archive' && (!trashedCanvases.length ? <EmptyDialog label="Trash" message="Trash is empty." icon={Trash2} close={closeOverlay} /> :
      <CanvasDialog title="Trash" close={closeOverlay}><div className="ic-form">
        {trashedCanvases.map(project => <div className="ic-row" key={project.id}>
          <span>{project.name}</span>
          <button className="ic-button" disabled={!canEdit} onClick={() => {
            void canvases.write([{ ...project, trashedAt: undefined, updatedAt: Date.now() }]).catch(() => {})
          }}>Restore {project.name}</button>
        </div>)}
        {canvases.error && <p role="alert">{canvases.error}</p>}
      </div></CanvasDialog>)}
    {overlay === 'new' && <Modal className="small-modal" label="New page preview" close={() => setOverlay(null)}><div className="simple-dialog">
      <FileText /><h2>New page</h2><p>Preview a document or database template.</p><div className="template-actions">
        <button className="quiet-button" onClick={() => go('handbook')}><ClipboardList /> Document</button>
        <button className="quiet-button" onClick={() => go('projects')}><LayoutGrid /> Database</button>
      </div>
    </div></Modal>}
    {overlay === 'about' && <Modal className="small-modal" label="About Croft" close={() => setOverlay(null)}><div className="simple-dialog">
      <span className="workspace-badge"><Mark /></span><h2>Croft</h2><p>Croft — Space to grow.</p><button className="quiet-button" onClick={() => setOverlay(null)}>Done</button>
    </div></Modal>}
  </div>
}
