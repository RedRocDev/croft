import {
  ArrowDownUp, ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Check,
  ChevronDown, Circle, Columns3, Command, FileText, GalleryVerticalEnd,
  List, PanelRightOpen, Plus, Search, SlidersHorizontal, Table2, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './database.css'

export type DatabaseView = 'table' | 'board' | 'calendar' | 'gallery' | 'list'

type Status = 'Planned' | 'In progress' | 'In review' | 'Done'
type Sort = 'Workspace order' | 'Name' | 'Due date' | 'Status'
type Popup = 'filter' | 'sort' | 'layout' | 'new'

type Project = {
  id: string
  name: string
  status: Status
  category: string
  person: string
  initials: string
  due: number
  art: string
  intro: string
}

const projects: Project[] = [
  { id: 'atlas', name: 'Atlas identity', status: 'In progress', category: 'Brand', person: 'Maya Chen', initials: 'MC', due: 5, art: 'atlas', intro: 'Refine the visual identity for Atlas, an independent architecture practice working across the Pacific Northwest. The current direction pairs a modular wordmark with a warm editorial palette.' },
  { id: 'meridian', name: 'Meridian Editorial', status: 'In review', category: 'Editorial', person: 'Owen Park', initials: 'OP', due: 9, art: 'meridian', intro: 'Build the design system for a quarterly publication on cities, craft, and the built environment. The first print proofs are ready for review.' },
  { id: 'northline', name: 'Northline Design System', status: 'In progress', category: 'Product', person: 'Ava Patel', initials: 'AP', due: 12, art: 'northline', intro: 'Unify Northline’s product surfaces with shared type, spacing, and colour tokens. Current work focuses on the navigation and form patterns.' },
  { id: 'seasonal', name: 'Seasonal lookbook', status: 'Planned', category: 'Editorial', person: 'Sofia Reyes', initials: 'SR', due: 16, art: 'seasonal', intro: 'Plan the next seasonal lookbook. The initial brief calls for restrained typography, full-bleed imagery, and a digital edition that works on narrow screens.' },
  { id: 'common', name: 'Common Ground website', status: 'In review', category: 'Web', person: 'Maya Chen', initials: 'MC', due: 19, art: 'common', intro: 'Create a site for a neighbourhood arts organisation. The first round covers the events calendar, residency profiles, and accessibility review.' },
  { id: 'index', name: 'Studio Index', status: 'Done', category: 'Internal', person: 'Owen Park', initials: 'OP', due: 3, art: 'index', intro: 'Organise the studio’s project archive by client, discipline, and year. The new index includes artwork, naming guidelines, and print-ready export files.' },
  { id: 'form', name: 'Form & Field packaging', status: 'Planned', category: 'Brand', person: 'Sofia Reyes', initials: 'SR', due: 24, art: 'form', intro: 'Develop a flexible packaging family for Form & Field. Next step is to request production samples and align on the sustainable materials shortlist.' },
  { id: 'open', name: 'Open House toolkit', status: 'Done', category: 'Brand', person: 'Ava Patel', initials: 'AP', due: 27, art: 'open', intro: 'An identity toolkit for the autumn open house, with templates for wayfinding, invitations, and event programmes.' },
]

const statuses: Status[] = ['Planned', 'In progress', 'In review', 'Done']
const viewOptions = [
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'board', label: 'Board', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'gallery', label: 'Gallery', icon: GalleryVerticalEnd },
  { id: 'list', label: 'List', icon: List },
] as const
const sortOptions: Sort[] = ['Workspace order', 'Name', 'Due date', 'Status']
const statusClass = (status: Status) => status.toLowerCase().replace(' ', '-')

function StatusPill({ status }: { status: Status }) {
  return <span className={`db-status db-status--${statusClass(status)}`}><i />{status}</span>
}

function Person({ project }: { project: Project }) {
  return <span className="db-person"><span className="db-avatar" data-person={project.initials}>{project.initials}</span>{project.person}</span>
}

function DateLabel({ day }: { day: number }) {
  return <time className="db-date" dateTime={`2026-11-${String(day).padStart(2, '0')}`}>{day} Nov 2026</time>
}

function ProjectName({ project, onOpen }: { project: Project; onOpen: (project: Project) => void }) {
  return <button className="db-record-name" onClick={() => onOpen(project)}><FileText size={15} />{project.name}</button>
}

function ProjectTable({ records, onOpen, onNew }: { records: Project[]; onOpen: (project: Project) => void; onNew: () => void }) {
  return <div className="db-table-wrap">
    <table className="db-table">
      <thead><tr>
        <th scope="col"><span className="db-property-type">Aa</span> Project</th>
        <th scope="col"><Circle size={13} /> Status</th>
        <th scope="col"><List size={13} /> Discipline</th>
        <th scope="col"><span className="db-property-type">◎</span> Lead</th>
        <th scope="col"><CalendarDays size={13} /> Due date</th>
      </tr></thead>
      <tbody>
        {records.map(project => <tr key={project.id}>
          <td><ProjectName project={project} onOpen={onOpen} /></td>
          <td><StatusPill status={project.status} /></td>
          <td><span className="db-category">{project.category}</span></td>
          <td><Person project={project} /></td>
          <td><DateLabel day={project.due} /></td>
        </tr>)}
      </tbody>
    </table>
    {!records.length && <p className="db-empty">No projects match the current filters.</p>}
    <button className="db-add db-table-add" onClick={onNew}><Plus size={15} /> New project</button>
    <div className="db-count">{records.length} {records.length === 1 ? 'project' : 'projects'}</div>
  </div>
}

function ProjectBoard({ records, onOpen, onNew }: { records: Project[]; onOpen: (project: Project) => void; onNew: () => void }) {
  return <div className="db-board">
    {statuses.map(status => {
      const items = records.filter(project => project.status === status)
      return <section key={status} className={`db-board-column db-board-column--${statusClass(status)}`} aria-label={status}>
        <header><StatusPill status={status} /><span>{items.length}</span><button className="db-icon" aria-label={`New project in ${status}`} onClick={onNew}><Plus size={15} /></button></header>
        {items.map(project => <article className="db-board-card" key={project.id}>
          <ProjectName project={project} onOpen={onOpen} />
          <span className="db-category">{project.category}</span>
          <footer><span className="db-avatar" data-person={project.initials} title={project.person}>{project.initials}</span><DateLabel day={project.due} /></footer>
        </article>)}
        <button className="db-add" onClick={onNew}><Plus size={15} /> New project</button>
      </section>
    })}
  </div>
}

function ProjectCalendar({ records, onOpen }: { records: Project[]; onOpen: (project: Project) => void }) {
  const [period, setPeriod] = useState({ year: 2026, month: 10 })
  const periodStart = new Date(period.year, period.month, 1)
  const firstWeekday = (periodStart.getDay() + 6) % 7
  const lastDay = new Date(period.year, period.month + 1, 0).getDate()
  const cellCount = Math.ceil((lastDay + firstWeekday) / 7) * 7
  const currentMonth = period.year === 2026 && period.month === 10
  const caption = periodStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

  function moveMonth(step: number) {
    const next = new Date(period.year, period.month + step, 1)
    setPeriod({ year: next.getFullYear(), month: next.getMonth() })
  }

  return <section className="db-calendar" aria-label={caption}>
    <div className="db-calendar-top">
      <h2>{caption}</h2>
      <button className="db-icon" aria-label="Previous month" onClick={() => moveMonth(-1)}><ArrowLeft size={16} /></button>
      <button className="db-icon" aria-label="Next month" onClick={() => moveMonth(1)}><ArrowRight size={16} /></button>
      <button className="db-calendar-return" onClick={() => setPeriod({ year: 2026, month: 10 })}>Today</button>
    </div>
    <div className="db-calendar-week">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="db-calendar-grid">
      {Array.from({ length: cellCount }, (_, index) => {
        const day = index + 1 - firstWeekday
        const date = new Date(period.year, period.month, day)
        const inMonth = day >= 1 && day <= lastDay
        const referenceDate = currentMonth && day === 13
        const scheduled = inMonth && currentMonth ? records.filter(project => project.due === day) : []
        return <div key={index} className={`db-calendar-cell${inMonth ? '' : ' db-calendar-cell--outside'}`}>
          <span className={`db-day${referenceDate ? ' db-day--today' : ''}`}>{date.getDate()}</span>
          {scheduled.map(project => <button className={`db-calendar-event db-status--${statusClass(project.status)}`} title={project.name} key={project.id} onClick={() => onOpen(project)}>{project.name}</button>)}
        </div>
      })}
    </div>
  </section>
}

function ProjectGallery({ records, onOpen, onNew }: { records: Project[]; onOpen: (project: Project) => void; onNew: () => void }) {
  return <div className="db-gallery">
    {records.map(project => <button className="db-gallery-card" key={project.id} onClick={() => onOpen(project)}>
      <div className={`db-art db-art--${project.art}`} aria-hidden="true"><span /><i /></div>
      <div className="db-gallery-copy">
        <strong><FileText size={15} />{project.name}</strong>
        <span className="db-gallery-meta"><StatusPill status={project.status} /><span>{project.category}</span></span>
      </div>
    </button>)}
    <button className="db-gallery-create" onClick={onNew}><Plus size={17} /> New project</button>
  </div>
}

function ProjectList({ records, onOpen, onNew }: { records: Project[]; onOpen: (project: Project) => void; onNew: () => void }) {
  return <div className="db-list">
    {records.map(project => <div className="db-list-row" key={project.id}>
      <ProjectName project={project} onOpen={onOpen} />
      <StatusPill status={project.status} /><DateLabel day={project.due} />
    </div>)}
    {!records.length && <p className="db-empty">No projects match the current filters.</p>}
    <button className="db-add" onClick={onNew}><Plus size={15} /> New project</button>
  </div>
}

export function Database({ view, onView }: { view: DatabaseView; onView: (view: DatabaseView) => void }) {
  const [popup, setPopup] = useState<Popup | null>(null)
  const [filter, setFilter] = useState<Status | null>(null)
  const [sort, setSort] = useState<Sort>('Workspace order')
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [peek, setPeek] = useState<Project | 'draft' | null>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const peekClose = useRef<HTMLButtonElement>(null)
  const peekOrigin = useRef<HTMLElement | null>(null)
  const records = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = projects.filter(project => (!filter || project.status === filter) &&
      (!needle || [project.name, project.person, project.category].some(value => value.toLowerCase().includes(needle))))
    if (sort === 'Name') visible.sort((left, right) => left.name.localeCompare(right.name))
    if (sort === 'Due date') visible.sort((left, right) => left.due - right.due)
    if (sort === 'Status') visible.sort((left, right) => statuses.indexOf(left.status) - statuses.indexOf(right.status))
    return visible
  }, [filter, sort, query])

  useEffect(() => {
    if (peek) {
      peekClose.current?.focus()
    } else {
      peekOrigin.current?.focus()
      peekOrigin.current = null
    }
  }, [peek])

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (toolbar.current && !toolbar.current.contains(event.target as Node)) setPopup(null)
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (popup) setPopup(null)
      else if (peek) setPeek(null)
      else {
        setShowSearch(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [popup, peek])

  function openPeek(project: Project | 'draft') {
    if (document.activeElement instanceof HTMLElement) {
      peekOrigin.current = document.activeElement
    }
    setPopup(null)
    setPeek(project)
  }

  const openNew = () => openPeek('draft')

  function togglePopup(next: Popup) {
    setPopup(current => current === next ? null : next)
  }

  function chooseView(next: DatabaseView) {
    onView(next)
    setPopup(null)
  }

  const peekTitle = peek === 'draft' ? 'New project' : peek?.name

  return <section className="database" aria-label="Projects database">
    <div className="db-page-heading">
      <div className="db-page-icon" aria-hidden="true"><GalleryVerticalEnd size={29} strokeWidth={1.65} /></div>
      <h1>Projects</h1>
      <p>Track active and upcoming work across the studio.</p>
    </div>
    <div className="db-toolbar" ref={toolbar}>
      <div className="db-views" aria-label="Database views">
        {viewOptions.map(({ id, icon: Icon, label }) => <button key={id} className={`db-view${id === view ? ' db-view--active' : ''}`} aria-pressed={id === view} onClick={() => chooseView(id)}><Icon size={15} />{label}</button>)}
      </div>
      <div className="db-actions">
        {showSearch && <input
          autoFocus
          className="db-search"
          aria-label="Search projects"
          placeholder="Search projects…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />}
        <button className="db-icon" title="Search" aria-label="Search" aria-pressed={showSearch} onClick={() => {
          setPopup(null)
          setShowSearch(!showSearch)
          if (showSearch) setQuery('')
        }}><Search size={16} /></button>
        <button className="db-icon" title="Filter" aria-label="Filter" aria-expanded={popup === 'filter'} data-active={Boolean(filter)} onClick={() => togglePopup('filter')}><List size={16} /></button>
        <button className="db-icon" title="Sort" aria-label="Sort" aria-expanded={popup === 'sort'} data-active={sort !== 'Workspace order'} onClick={() => togglePopup('sort')}><ArrowDownUp size={15} /></button>
        <button className="db-icon" title="View options" aria-label="View options" aria-expanded={popup === 'layout'} onClick={() => togglePopup('layout')}><SlidersHorizontal size={15} /></button>
        <span className="db-new"><button className="db-new-main" onClick={openNew}>New</button><button className="db-new-menu" aria-label="New project options" aria-expanded={popup === 'new'} onClick={() => togglePopup('new')}><ChevronDown size={14} /></button></span>
      </div>
      {popup && <div className="db-popover" aria-label={`${popup} options`}>
        {popup === 'filter' && <>
          <h2>Filter by status</h2>
          <button className="db-option" onClick={() => { setFilter(null); setPopup(null) }}>All statuses{!filter && <Check size={15} />}</button>
          {statuses.map(status => <button key={status} className="db-option" onClick={() => { setFilter(status); setPopup(null) }}><StatusPill status={status} />{status === filter && <Check size={15} />}</button>)}
        </>}
        {popup === 'sort' && <>
          <h2>Sort projects</h2>
          {sortOptions.map(option => <button key={option} className="db-option" onClick={() => { setSort(option); setPopup(null) }}>{option}{option === sort && <Check size={15} />}</button>)}
        </>}
        {popup === 'layout' && <>
          <h2>Layout</h2>
          {viewOptions.map(({ id, icon: Icon, label }) => <button key={id} className="db-option" onClick={() => chooseView(id)}><span><Icon size={15} />{label}</span>{id === view && <Check size={15} />}</button>)}
        </>}
        {popup === 'new' && <>
          <h2>New project</h2>
          <button className="db-option" onClick={openNew}><span><Plus size={15} />Blank project preview</span><ArrowUpRight size={14} /></button>
        </>}
      </div>}
    </div>
    {filter && <div className="db-applied"><button onClick={() => setFilter(null)} aria-label={`Clear status filter ${filter}`}>Status: {filter}<X size={13} /></button></div>}
    {view === 'table' && <ProjectTable records={records} onOpen={openPeek} onNew={openNew} />}
    {view === 'board' && <ProjectBoard records={records} onOpen={openPeek} onNew={openNew} />}
    {view === 'calendar' && <ProjectCalendar records={records} onOpen={openPeek} />}
    {view === 'gallery' && <ProjectGallery records={records} onOpen={openPeek} onNew={openNew} />}
    {view === 'list' && <ProjectList records={records} onOpen={openPeek} onNew={openNew} />}
    {peek && (
      <aside className="db-peek" aria-label={peekTitle}>
        <div className="db-peek-top">
          <span><PanelRightOpen size={15} /> Projects</span>
          <button ref={peekClose} className="db-icon" onClick={() => setPeek(null)} title="Close side peek" aria-label="Close side peek"><X size={17} /></button>
        </div>
        <div className="db-peek-body">
          <div className="db-peek-icon"><FileText size={26} /></div>
          <h2>{peekTitle}</h2>
          {peek === 'draft' ? <div className="db-preview-notice"><Command size={16} /> Read-only preview of a new project.</div> :
            <>
              <dl>
                <dt><Circle size={14} />Status</dt><dd><StatusPill status={peek.status} /></dd>
                <dt><List size={14} />Discipline</dt><dd><span className="db-category">{peek.category}</span></dd>
                <dt><span>◎</span> Lead</dt><dd><Person project={peek} /></dd>
                <dt><CalendarDays size={14} />Due date</dt><dd><DateLabel day={peek.due} /></dd>
              </dl>
              <hr />
              <h3>Overview</h3>
              <p>{peek.intro}</p>
            </>}
        </div>
      </aside>
    )}
  </section>
}
