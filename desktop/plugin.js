/**
 * Answer Summary — a small AI recap of the latest assistant reply, sitting in
 * the composer's top strip (above the input, below the transcript), plus an
 * on-demand recap of the whole session.
 *
 * Flow: watch `message.complete` for the focused session (or read the last
 * assistant message from `session.history` when a session opens), ask
 * `llm.oneshot` for a 1-3 line recap through the auxiliary title-generation
 * model, and cache it by message hash so nothing is re-summarised. The session
 * recap is map-reduced from the full transcript and cached separately.
 *
 * Plain ESM: loaded uncompiled. UI is jsx()/jsxs() calls, NOT JSX syntax.
 */

import {
  Button,
  COMPOSER_AREAS,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  host,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useValue,
  writeClipboardText
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'answer-summary'
const CACHE_KEY = 'hermes.answer-summary.v1'
const RECAP_CACHE_KEY = 'hermes.answer-summary.session.v1'
const DISCUSS_STORE_KEY = 'hermes.answer-summary.discuss.v1'
const DISCUSS_REGISTRY_KEY = 'hermes.answer-summary.discuss.registry.v1'
const MAX_CACHE = 120
const MAX_RECAP_CACHE = 24
const MAX_INPUT = 7000
const MIN_LEN = 200
const RECAP_CHUNK_CHARS = 8000
const MAX_RECAP_CHUNKS = 6
const RECAP_PART_TOKENS = 320
const RECAP_FINAL_TOKENS = 600
const RECAP_PROMPT_VERSION = 'v2'
const DISCUSSION_PREFIX =
  '[Discussion-only side session. Do not call tools. Do not modify files. Answer from the provided session context. If the context is insufficient, say so plainly.]\n\n'
const DISCUSSION_SEED_MAX_MESSAGES = 80
const DISCUSSION_SEED_MAX_CHARS = 40000

const INSTRUCTIONS = [
  'You summarise an AI assistant reply for the person who just received it.',
  'Write 1-3 very short bullet points, plain text, each under 18 words, no markdown symbols, no preamble.',
  'Lead with the outcome or the answer. Include only what the reader must know or act on.',
  'If the reply is a simple confirmation or a one-line answer, reply with a single short sentence instead.'
].join(' ')

const RECAP_PART_INSTRUCTIONS = [
  'You are reading one portion of a long Hermes agent session.',
  'Extract only what matters for a later session recap: the user asks, actions taken, decisions, files or commands touched, results, and anything left unresolved.',
  'Write 4-7 short plain-text bullets. No preamble, no markdown symbols.',
  'Be concrete: names, paths, numbers and outcomes.'
].join(' ')

const RECAP_FINAL_INSTRUCTIONS = [
  'You write a session recap for the person who owns this Hermes session.',
  'You receive summaries of consecutive parts of the session.',
  'Produce these sections, each heading alone on its own line, and omit a section only if it has nothing:',
  'WHAT HAPPENED',
  'DECISIONS',
  'FILES CHANGED',
  'OPEN LOOPS',
  'NEEDS YOUR INPUT',
  'Use 2-4 short bullets per section, each under 20 words. Keep the whole recap under 220 words.',
  'Plain text only, no markdown symbols, no preamble, no closing summary.',
  'Be concrete: file paths, commands, people, numbers. In NEEDS YOUR INPUT list only questions or approvals the user must answer; write None when there are none.'
].join(' ')

const HANDOFF_INSTRUCTIONS = [
  'You summarise a side discussion so it can be handed back to the main agent.',
  'The user may have only asked a question and received advice. Do NOT describe advice as a decision, agreement, or outcome unless the user explicitly said they agreed.',
  'Return plain text with these sections, each heading alone on its own line:',
  'USER ASKED',
  'SIDE SESSION ADVISED',
  'DECISIONS',
  'SUGGESTED NEXT ACTIONS',
  'CONFIRM WITH USER',
  'In DECISIONS, record only decisions the user explicitly stated. If the user did not decide anything, write exactly: None recorded.',
  'In SUGGESTED NEXT ACTIONS, list what the side session recommended, not what the user agreed to.',
  'In CONFIRM WITH USER, list the questions the main session should ask the user before acting, ideally as a Hermes questionnaire.',
  'Use 2-4 short bullets per section, each under 20 words. No preamble, no markdown symbols. Be concrete and preserve the distinction between the user and the assistant.'
].join(' ')


// ── live completion store ────────────────────────────────────────────────────
// message.complete gives us the final text without re-reading a long history.
const latestBySession = new Map()
const listeners = new Set()
let version = 0

function emit() {
  version += 1
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* listener isolation */
    }
  }
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function snapshot() {
  return version
}

// ── summary cache (localStorage, per profile + session + message hash) ──────
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let cache = readCache()

function writeCache() {
  try {
    const rows = Object.entries(cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    cache = Object.fromEntries(rows.slice(0, MAX_CACHE))
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* storage full or unavailable: in-memory cache still works */
  }
}

// ── session recap cache ──────────────────────────────────────────────────────
function readRecapCache() {
  try {
    const raw = localStorage.getItem(RECAP_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let recapCache = readRecapCache()

function writeRecapCache() {
  try {
    const rows = Object.entries(recapCache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    recapCache = Object.fromEntries(rows.slice(0, MAX_RECAP_CACHE))
    localStorage.setItem(RECAP_CACHE_KEY, JSON.stringify(recapCache))
  } catch {
    /* storage full or unavailable */
  }
}


function hashText(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'assistant') {
      continue
    }
    // session.history projects assistant rows as `text`; live payloads and
    // some older projections use `content`. Accept either.
    const raw =
      typeof m.text === 'string' && m.text.trim()
        ? m.text
        : typeof m.content === 'string'
          ? m.content
          : ''
    const text = raw.trim()
    if (!text || text.startsWith('[System:')) {
      continue
    }
    return text
  }
  return ''
}

function clip(text, limit) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) {
    return ''
  }
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}…`
}

function messageText(m) {
  if (!m) {
    return ''
  }
  if (typeof m.text === 'string' && m.text.trim()) {
    return m.text.trim()
  }
  if (typeof m.content === 'string' && m.content.trim()) {
    return m.content.trim()
  }
  return ''
}

/** Compact, readable transcript for the recap model: user asks, assistant
 *  answers, and tool activity without full tool payloads. */
function buildTranscript(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }
  const lines = []
  for (const m of messages) {
    if (!m || m.display_kind === 'hidden') {
      continue
    }
    if (m.role === 'user') {
      const text = clip(messageText(m), 1600)
      if (text) {
        lines.push(`USER:\n${text}`)
      }
    } else if (m.role === 'assistant') {
      const text = clip(messageText(m), 2600)
      if (text) {
        lines.push(`ASSISTANT:\n${text}`)
      }
    } else if (m.role === 'tool') {
      const name = m.name || 'tool'
      const context = clip(m.context || '', 220)
      lines.push(context ? `TOOL ${name}: ${context}` : `TOOL ${name}`)
    }
  }
  return lines.join('\n\n')
}

function chunkTranscript(transcript, maxChars) {
  const blocks = transcript.split('\n\n')
  const chunks = []
  let current = ''
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current)
      current = block
    } else {
      current = current ? `${current}\n\n${block}` : block
    }
  }
  if (current) {
    chunks.push(current)
  }
  return chunks
}


// ── UI ──────────────────────────────────────────────────────────────────────
const wrap = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0,
  padding: '7px 9px',
  borderRadius: '10px',
  border: '1px solid color-mix(in srgb, var(--ui-accent) 20%, var(--ui-stroke-secondary))',
  background: 'color-mix(in srgb, var(--ui-accent) 6%, transparent)',
  color: 'var(--ui-text-secondary)',
  fontSize: '11.5px',
  lineHeight: 1.45
}

const head = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  cursor: 'pointer',
  userSelect: 'none'
}

const label = {
  fontWeight: 600,
  letterSpacing: '0.01em',
  color: 'var(--ui-text-primary)',
  flexShrink: 0
}

const muted = {
  color: 'var(--ui-text-tertiary)'
}

const bodyCollapsed = {
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  color: 'var(--ui-text-primary)',
  fontWeight: 500
}

const bodyExpanded = {
  overflow: 'auto',
  maxHeight: '180px',
  whiteSpace: 'pre-wrap',
  color: 'var(--ui-text-primary)',
  fontWeight: 500
}

const iconButton = {
  border: '1px solid var(--ui-stroke-secondary)',
  background: 'var(--ui-chat-bubble-opaque-background, var(--ui-bg-editor))',
  color: 'var(--ui-text-secondary)',
  cursor: 'pointer',
  padding: '1px 4px',
  borderRadius: '4px',
  fontSize: '12px',
  lineHeight: 1,
  minWidth: '18px',
  height: '18px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0
}

const summaryPill = {
  ...iconButton,
  fontSize: '10px',
  lineHeight: 1.2,
  padding: '1px 6px',
  borderRadius: '5px',
  whiteSpace: 'nowrap',
  minWidth: '68px',
  width: '68px',
  border: '1px solid color-mix(in srgb, var(--ui-accent) 42%, var(--ui-stroke-secondary))',
  background: 'color-mix(in srgb, var(--ui-accent) 30%, var(--ui-bg-editor))',
  color: 'var(--ui-text-primary)'
}

const iconStack = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: '3px',
  flexShrink: 0
}

const recapPanel = {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  padding: '0 0 6px',
  marginBottom: '2px',
  borderBottom: '1px solid var(--ui-stroke-secondary)'
}

const recapHead = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  userSelect: 'none'
}

const recapTitle = {
  fontWeight: 600,
  color: 'var(--ui-text-primary)',
  flexShrink: 0
}

const recapMeta = {
  color: 'var(--ui-text-secondary)',
  fontSize: '10px',
  opacity: 0.8,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis'
}

const recapBody = {
  maxHeight: '210px',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  color: 'var(--ui-text-secondary)',
  fontSize: '11px',
  lineHeight: 1.45
}

const recapHeading = {
  fontWeight: 600,
  color: 'var(--ui-text-primary)',
  marginTop: '4px'
}

const recapLine = {
  whiteSpace: 'pre-wrap',
  marginBottom: '1px'
}

const recapBullet = {
  whiteSpace: 'pre-wrap',
  paddingLeft: '10px',
  textIndent: '-10px',
  marginBottom: '2px'
}

function recapLines(text) {
  return String(text || '')
    .split('\n')
    .map((line, index) => {
      const trimmed = line.trim()
      const isHeading = /^[A-Z][A-Z0-9 /&()'-]{2,40}$/.test(trimmed) && !trimmed.endsWith('.')
      const isBullet = /^[-•*]\s/.test(trimmed)
      return jsx('div', {
        key: index,
        style: isHeading ? recapHeading : isBullet ? recapBullet : recapLine,
        children: line || ' '
      })
    })
}

// ── discuss side chats ──────────────────────────────────────────────────────
// One branch per main session (or more, if the user chooses New). The side
// chat is a real child session: full parent transcript, its own model, its own
// turns. The pane is a right-docked plugin surface, not a core chat tile.
const discussByParent = new Map(Object.entries(readDiscussStore()))
const discussChats = new Map()
const discussListeners = new Set()
let discussVersion = 0

function readDiscussStore() {
  try {
    const raw = localStorage.getItem(DISCUSS_STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') {
        continue
      }
      if (Array.isArray(value.sessions)) {
        out[key] = {
          active: value.active || value.sessions[0] || null,
          sessions: value.sessions
        }
      } else if (value.childStoredId) {
        out[key] = { active: value, sessions: [value] }
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveDiscussStore() {
  try {
    localStorage.setItem(DISCUSS_STORE_KEY, JSON.stringify(Object.fromEntries(discussByParent)))
  } catch {
    /* storage unavailable */
  }
}

const discussRegistry = new Map(Object.entries(readDiscussRegistry()))

function readDiscussRegistry() {
  try {
    const raw = localStorage.getItem(DISCUSS_REGISTRY_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveDiscussRegistry() {
  try {
    localStorage.setItem(
      DISCUSS_REGISTRY_KEY,
      JSON.stringify(Object.fromEntries(discussRegistry))
    )
  } catch {
    /* storage unavailable */
  }
}

function backfillDiscussRegistry() {
  let changed = false
  for (const state of discussByParent.values()) {
    const records = state && Array.isArray(state.sessions) ? state.sessions : []
    for (const record of records) {
      if (!record || !record.childStoredId || discussRegistry.has(record.childStoredId)) {
        continue
      }
      discussRegistry.set(record.childStoredId, {
        parentKey: record.parentKey || '',
        parentStoredId:
          record.parentStoredId || (record.parentKey || '').split('\u0000')[1] || '',
        childStoredId: record.childStoredId,
        childRuntimeId: record.childRuntimeId || '',
        title: record.title || 'Discuss',
        model: record.model || '',
        initialCount: record.initialCount || 0,
        createdAt: record.createdAt || Date.now()
      })
      changed = true
    }
  }
  if (changed) {
    saveDiscussRegistry()
  }
}

backfillDiscussRegistry()

function emitDiscuss() {
  discussVersion += 1
  for (const fn of discussListeners) {
    try {
      fn()
    } catch {
      /* listener isolation */
    }
  }
}

function subscribeDiscuss(fn) {
  discussListeners.add(fn)
  return () => discussListeners.delete(fn)
}

function discussSnapshot() {
  return discussVersion
}

// Dialog/busy state shared by the summary bubble and the always-visible
// composer launcher. One dialog owner avoids two copies fighting over open.
const discussUi = { busy: false, error: '', dialog: null }
const discussUiListeners = new Set()
let discussUiVersion = 0

function emitDiscussUi() {
  discussUiVersion += 1
  for (const fn of discussUiListeners) {
    try {
      fn()
    } catch {
      /* listener isolation */
    }
  }
}

function subscribeDiscussUi(fn) {
  discussUiListeners.add(fn)
  return () => discussUiListeners.delete(fn)
}

function discussUiSnapshot() {
  return discussUiVersion
}

function setDiscussUi(patch) {
  Object.assign(discussUi, patch)
  emitDiscussUi()
}

function currentDiscussParent() {
  const sessionId = host.state.focusedSessionId.get()
  const storedId = host.state.focusedStoredSessionId.get()
  const profile = host.state.focusedSessionProfile.get()
  return {
    sessionId,
    storedId,
    profile,
    key: `${profile || ''}\u0000${storedId || sessionId || ''}`
  }
}

function latestRecapFor(parentKey) {
  const prefix = `${parentKey}\u0000${RECAP_PROMPT_VERSION}\u0000`
  const rows = Object.entries(recapCache)
    .filter(([key]) => key.startsWith(prefix))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
  return (rows[0] && rows[0][1] && rows[0][1].text) || ''
}

/** Newest-biased seed from the LIVE session history. Tool-call-only assistant
 *  rows are skipped, so a 400-message working context collapses to the
 *  user/assistant conversation that matters for a decision side chat. */
function buildDiscussSeed(messages) {
  const rows = []
  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      continue
    }
    if (message.display_kind === 'hidden') {
      continue
    }
    const text = messageText(message).trim()
    if (!text || text.startsWith('[System:')) {
      continue
    }
    rows.push({ role: message.role, content: text })
  }
  const selected = []
  let used = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (selected.length >= DISCUSSION_SEED_MAX_MESSAGES) {
      break
    }
    const row = rows[i]
    if (selected.length && used + row.content.length + 2 > DISCUSSION_SEED_MAX_CHARS) {
      break
    }
    selected.push(row)
    used += row.content.length + 2
  }
  selected.reverse()
  while (selected.length && selected[0].role !== 'user') {
    selected.shift()
  }
  return selected
}

function cleanDiscussTitle(text) {
  let value = String(text || '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,]+$/g, '')
    .trim()
  if (value.length > 60) {
    value = `${value.slice(0, 57).trimEnd()}…`
  }
  return value
}

async function generateDiscussTitle({ parentSessionId, latestReply, latestSummary, recap }) {
  const basis = String(latestSummary || latestReply || recap || '').trim()
  if (!basis) {
    return ''
  }
  try {
    const res = await host.request(
      'llm.oneshot',
      {
        session_id: parentSessionId,
        instructions:
          'Write a 3-6 word title for a side discussion about the latest main-session context. Describe the concrete topic. Do not use the words "Discuss", "Side chat", "Summary", or "Session". Return only the title, no quotes and no trailing punctuation.',
        input: basis.slice(0, 2000),
        max_tokens: 24,
        temperature: 0.2,
        task: 'title_generation'
      },
      30000
    )
    const title = cleanDiscussTitle(res && typeof res.text === 'string' ? res.text : '')
    if (/^(discuss|side chat|summary|session|untitled)$/i.test(title)) {
      return ''
    }
    return title
  } catch {
    return ''
  }
}

async function createDiscuss() {
  const parent = currentDiscussParent()
  if (!parent.sessionId || discussUi.busy) {
    return
  }
  setDiscussUi({ busy: true, error: '', dialog: null })
  try {
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
    const fallbackTitle = `Discuss · ${stamp} · ${Math.random().toString(36).slice(2, 6)}`
    let parentModel = ''
    let parentProvider = ''
    await host
      .request('model.options', { session_id: parent.sessionId }, 60000)
      .then(res => {
        parentModel = (res && res.model) || ''
        parentProvider = (res && res.provider) || ''
      })
      .catch(() => undefined)
    const history = await host.request(
      'session.history',
      { session_id: parent.sessionId },
      60000
    )
    const messages = (history && history.messages) || []
    const seed = buildDiscussSeed(messages)
    const latestReply = lastAssistantText(messages)
    const summaryKey = latestReply ? `${parent.key}\u0000${hashText(latestReply)}` : ''
    const cachedSummary =
      summaryKey && cache[summaryKey] && cache[summaryKey].summary
        ? cache[summaryKey].summary
        : ''
    const recap = latestRecapFor(parent.key)
    const seedTranscript = seed
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n')
      .slice(0, 16000)
    const semanticTitle = await generateDiscussTitle({
      parentSessionId: parent.sessionId,
      latestReply,
      latestSummary: cachedSummary,
      recap
    })
    const desiredTitle = semanticTitle ? `Discuss: ${semanticTitle}` : fallbackTitle
    const contextNote = recap
      ? `Earlier session recap:\n${recap}\n\nThe transcript below is the most recent part of the main session.`
      : 'The transcript below is a compacted view of the main session.'
    const seeded = [
      {
        role: 'system',
        content: `You are a discussion-only side session branched from the main chat. The main chat is untouched. Do not call tools. Do not modify files. Answer from the provided context. ${contextNote}`
      },
      ...seed
    ]
    const created = await host.request(
      'session.create',
      {
        parent_session_id: parent.storedId || undefined,
        messages: seeded,
        title: fallbackTitle,
        source: 'desktop',
        model: parentModel || undefined,
        provider: parentProvider || undefined,
        cwd: host.state.cwd.get() || undefined,
        hidden: true
      },
      120000
    )
    const childRuntimeId = created && created.session_id
    const childStoredId = created && created.stored_session_id
    if (!childRuntimeId || !childStoredId) {
      throw new Error('The side session did not start')
    }
    const initialCount = created.message_count || seeded.length
    let finalTitle = fallbackTitle
    if (desiredTitle !== fallbackTitle) {
      try {
        const titleResult = await host.request(
          'session.title',
          { session_id: childRuntimeId, title: desiredTitle },
          60000
        )
        finalTitle = (titleResult && titleResult.title) || desiredTitle
      } catch {
        const withStamp = `${desiredTitle} · ${stamp}`
        try {
          const titleResult = await host.request(
            'session.title',
            { session_id: childRuntimeId, title: withStamp },
            60000
          )
          finalTitle = (titleResult && titleResult.title) || withStamp
        } catch {
          finalTitle = fallbackTitle
        }
      }
    }
    // Discussion-only side chats must never stall on an approval the pane
    // cannot render. Session scope keeps this out of the profile config.
    await host
      .request(
        'config.set',
        { key: 'yolo', value: 'on', scope: 'session', session_id: childRuntimeId },
        60000
      )
      .catch(() => undefined)
    const record = {
      parentKey: parent.key,
      parentSessionId: parent.sessionId,
      parentStoredId: parent.storedId || parent.sessionId,
      childStoredId,
      childRuntimeId,
      initialCount,
      createdAt: Date.now(),
      title: finalTitle,
      model: parentModel || '',
      latestReply,
      latestSummary: cachedSummary,
      recap,
      seedTranscript
    }
    const previous = discussByParent.get(parent.key)
    const previousActive = previous && previous.active ? previous.active : null
    if (previousActive && previousActive.childStoredId !== childStoredId) {
      await host
        .request(
          'session.set_hidden',
          { session_id: previousActive.childStoredId, hidden: true },
          60000
        )
        .catch(() => undefined)
      previousActive.hidden = true
    }
    const state = discussByParent.get(parent.key) || { active: null, sessions: [] }
    state.sessions = [
      record,
      ...state.sessions.filter(item => item.childStoredId !== record.childStoredId)
    ].slice(0, 12)
    state.active = record
    discussByParent.set(parent.key, state)
    saveDiscussStore()
    discussRegistry.set(childStoredId, {
      parentKey: parent.key,
      parentStoredId: parent.storedId || parent.sessionId,
      childStoredId,
      childRuntimeId,
      title: finalTitle,
      model: parentModel || '',
      initialCount,
      createdAt: record.createdAt
    })
    saveDiscussRegistry()
    emitDiscuss()
    ensureChat(childRuntimeId, {
      storedId: childStoredId,
      initialCount,
      parentSessionId: parent.sessionId,
      parentKey: parent.key,
      latestReply,
      latestSummary: cachedSummary,
      recap,
      seedTranscript
    })
    emitDiscuss()
    openDiscussPane(record)
    setDiscussUi({ busy: false, error: '', dialog: null })
  } catch (err) {
    setDiscussUi({
      busy: false,
      error: (err && err.message) || 'Could not open the side chat',
      dialog: null
    })
  }
}

async function continueDiscuss(record) {
  if (!record || discussUi.busy) {
    return
  }
  setDiscussUi({ busy: true, error: '', dialog: null })
  try {
    const resumed = await host.request(
      'session.resume',
      { session_id: record.childStoredId, lazy: false },
      120000
    )
    const runtimeId = resumed && resumed.session_id
    if (!runtimeId) {
      throw new Error('Could not reopen the side chat')
    }
    const updated = { ...record, childRuntimeId: runtimeId }
    const state = discussByParent.get(record.parentKey) || { active: null, sessions: [] }
    state.active = updated
    state.sessions = state.sessions.map(item =>
      item.childStoredId === updated.childStoredId ? updated : item
    )
    discussByParent.set(record.parentKey, state)
    saveDiscussStore()
    discussRegistry.set(record.childStoredId, {
      ...(discussRegistry.get(record.childStoredId) || {}),
      parentKey: record.parentKey,
      parentStoredId:
        record.parentStoredId || (record.parentKey || '').split('\u0000')[1] || '',
      childStoredId: record.childStoredId,
      childRuntimeId: runtimeId,
      title: record.title || 'Discuss',
      model: record.model || '',
      initialCount: record.initialCount || 0,
      createdAt: record.createdAt || Date.now()
    })
    saveDiscussRegistry()
    emitDiscuss()
    ensureChat(runtimeId, {
      storedId: record.childStoredId,
      initialCount: record.initialCount || 0,
      parentSessionId: record.parentSessionId || '',
      parentKey: record.parentKey || '',
      latestReply: record.latestReply || '',
      latestSummary: record.latestSummary || '',
      recap: record.recap || '',
      seedTranscript: record.seedTranscript || ''
    })
    emitDiscuss()
    openDiscussPane(updated)
    setDiscussUi({ busy: false, error: '', dialog: null })
  } catch (err) {
    setDiscussUi({
      busy: false,
      error: (err && err.message) || 'Could not reopen the side chat',
      dialog: { record }
    })
  }
}

function requestDiscuss() {
  const parent = currentDiscussParent()
  if (!parent.sessionId || discussUi.busy) {
    return
  }
  const state = discussByParent.get(parent.key)
  const existing =
    state && state.active
      ? state.active
      : (state && state.sessions && state.sessions[0]) || null
  if (existing) {
    void continueDiscuss(existing)
    return
  }
  void createDiscuss()
}

function closeDiscussDialog() {
  setDiscussUi({ dialog: null })
}

function ensureChat(runtimeId, options = {}) {
  let chat = discussChats.get(runtimeId)
  if (!chat) {
    chat = {
      runtimeId,
      storedId: options.storedId || '',
      initialCount: options.initialCount || 0,
      contextCount: options.initialCount || 0,
      parentSessionId: options.parentSessionId || '',
      parentKey: options.parentKey || '',
      latestReply: options.latestReply || '',
      latestSummary: options.latestSummary || '',
      recap: options.recap || '',
      seedTranscript: options.seedTranscript || '',
      summaryLoading: false,
      recapLoading: false,
      messages: [],
      streaming: '',
      busy: false,
      status: '',
      error: '',
      hydrated: false
    }
    discussChats.set(runtimeId, chat)
  } else {
    if (options.storedId) {
      chat.storedId = options.storedId
    }
    if (options.initialCount != null) {
      chat.initialCount = options.initialCount
      chat.contextCount = options.initialCount
    }
    if (options.parentSessionId) {
      chat.parentSessionId = options.parentSessionId
    }
    if (options.parentKey) {
      chat.parentKey = options.parentKey
    }
    if (options.latestReply) {
      chat.latestReply = options.latestReply
    }
    if (options.latestSummary) {
      chat.latestSummary = options.latestSummary
    }
    if (options.recap) {
      chat.recap = options.recap
    }
    if (options.seedTranscript) {
      chat.seedTranscript = options.seedTranscript
    }
  }
  return chat
}

async function hydrateChat(runtimeId) {
  const chat = discussChats.get(runtimeId)
  if (!chat || chat.hydrated) {
    return
  }
  chat.hydrated = true
  try {
    const hist = await host.request('session.history', { session_id: runtimeId })
    const all = (hist && hist.messages) || []
    const tail = all.slice(chat.initialCount || 0)
    const messages = []
    for (const message of tail) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
        continue
      }
      if (message.display_kind === 'hidden') {
        continue
      }
      const text = messageText(message)
      if (text) {
        messages.push({ role: message.role, text })
      }
    }
    if (!chat.messages.length && messages.length) {
      chat.messages = messages
    }
    emitDiscuss()
  } catch {
    chat.hydrated = false
  }
}

function openDiscussPane(record) {
  host.openWorkspace('discuss-side', {
    title: record.title || 'Discuss',
    dock: { pane: 'workspace', pos: 'right' },
    minWidth: '24rem',
    render: () => jsx(DiscussPane, { chatId: record.childRuntimeId })
  })
}

const paneWrap = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  gap: '6px',
  padding: '10px',
  boxSizing: 'border-box'
}

const paneHeader = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  flexShrink: 0
}

const paneTitle = {
  fontWeight: 600,
  color: 'var(--ui-text-primary)',
  fontSize: '12px',
  flexShrink: 0
}

const paneMeta = {
  color: 'var(--ui-text-tertiary)',
  fontSize: '10px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis'
}

const paneNote = {
  color: 'var(--ui-text-tertiary)',
  fontSize: '10px',
  lineHeight: 1.4,
  padding: '0 0 6px',
  borderBottom: '1px solid var(--ui-stroke-secondary)'
}

const paneThread = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '7px',
  paddingRight: '2px'
}

const userBubble = {
  alignSelf: 'flex-end',
  maxWidth: '88%',
  padding: '6px 9px',
  borderRadius: '10px',
  background: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)',
  color: 'var(--ui-text-primary)',
  fontSize: '12px',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  userSelect: 'text'
}

const assistantBubble = {
  alignSelf: 'flex-start',
  maxWidth: '94%',
  padding: '6px 9px',
  borderRadius: '10px',
  background: 'color-mix(in srgb, var(--ui-text-secondary) 8%, transparent)',
  color: 'var(--ui-text-secondary)',
  fontSize: '12px',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  userSelect: 'text'
}

const composerBox = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: '8px',
  background: 'color-mix(in srgb, var(--ui-text-primary) 3%, transparent)',
  flexShrink: 0,
  overflow: 'hidden'
}

const composerFooter = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '0 6px 6px 8px'
}

const paneError = {
  color: 'var(--ui-red)',
  fontSize: '10px',
  lineHeight: 1.4
}

const contextCard = {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--ui-stroke-secondary)',
  background: 'color-mix(in srgb, var(--ui-accent) 4%, transparent)',
  flexShrink: 0
}

const contextHead = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  userSelect: 'none'
}

const contextLabel = {
  fontSize: '9px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ui-text-tertiary)'
}

const contextSection = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px'
}

const contextText = {
  fontSize: '11px',
  lineHeight: 1.4,
  color: 'var(--ui-text-secondary)',
  whiteSpace: 'pre-wrap',
  overflow: 'auto',
  userSelect: 'text'
}

const contextMore = {
  border: 'none',
  background: 'transparent',
  color: 'var(--ui-accent)',
  cursor: 'pointer',
  padding: 0,
  fontSize: '9px',
  lineHeight: 1.2,
  alignSelf: 'flex-start'
}

const managerList = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  maxHeight: '300px',
  overflow: 'auto'
}

const managerRow = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 0',
  borderBottom: '1px solid var(--ui-stroke-secondary)'
}

const managerTitle = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--ui-text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const managerMeta = {
  fontSize: '10px',
  color: 'var(--ui-text-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const discussPill = {
  border: '1px solid color-mix(in srgb, var(--ui-accent) 28%, var(--ui-stroke-secondary))',
  background: 'var(--ui-chat-bubble-opaque-background, var(--ui-bg-editor))',
  color: 'var(--ui-text-primary)',
  cursor: 'pointer',
  padding: '1px 5px',
  borderRadius: '5px',
  fontSize: '10px',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  flexShrink: 0
}

function DiscussPane({ chatId }) {
  useSyncExternalStore(subscribeDiscuss, discussSnapshot, discussSnapshot)
  const chat = discussChats.get(chatId)
  const [input, setInput] = useState('')
  const [models, setModels] = useState({
    loading: true,
    value: '',
    label: '',
    options: [],
    switching: false,
    error: ''
  })
  const scrollRef = useRef(null)
  const [contextOpen, setContextOpen] = useState(true)
  const [recapExpanded, setRecapExpanded] = useState(false)
  const [handoff, setHandoff] = useState({ status: 'idle', error: '' })
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerBusy, setManagerBusy] = useState('')
  const [managerError, setManagerError] = useState('')

  useEffect(() => {
    void hydrateChat(chatId)
  }, [chatId])

  useEffect(() => {
    if (!chat) {
      return
    }
    if (chat.latestReply && !chat.latestSummary && !chat.summaryLoading) {
      void loadLatestSummary(chat)
    }
    if (!chat.recap && !chat.recapLoading && chat.seedTranscript) {
      void loadRecap(chat)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  useEffect(() => {
    let alive = true
    host
      .request('model.options', { session_id: chatId })
      .then(res => {
        if (!alive) {
          return
        }
        const providers = (res && res.providers) || []
        const options = []
        for (const provider of providers) {
          if (!provider || provider.authenticated === false) {
            continue
          }
          const list =
            provider.models && provider.models.length
              ? provider.models
              : provider.featured_models || []
          for (const model of list) {
            options.push({
              value: `${provider.slug}\u0000${model}`,
              label: `${provider.name || provider.slug} · ${model}`,
              provider: provider.slug,
              model
            })
          }
        }
        const currentProvider = (res && res.provider) || ''
        const currentModel = (res && res.model) || ''
        const value =
          currentProvider && currentModel
            ? `${currentProvider}\u0000${currentModel}`
            : options[0]?.value || ''
        if (currentProvider && currentModel && !options.some(option => option.value === value)) {
          options.unshift({
            value,
            label: `${currentProvider} · ${currentModel}`,
            provider: currentProvider,
            model: currentModel
          })
        }
        setModels({
          loading: false,
          value,
          label: currentModel || options[0]?.label || '',
          options,
          switching: false,
          error: ''
        })
      })
      .catch(err => {
        if (alive) {
          setModels(state => ({
            ...state,
            loading: false,
            error: (err && err.message) || 'Could not load models'
          }))
        }
      })
    return () => {
      alive = false
    }
  }, [chatId])

  useEffect(() => {
    if (!chat || !chat.busy) {
      return
    }
    let alive = true
    const reconcile = async () => {
      try {
        const hist = await host.request('session.history', { session_id: chatId })
        if (!alive) {
          return
        }
        const all = (hist && hist.messages) || []
        const tail = all.slice(chat.initialCount || 0)
        let lastUser = -1
        let lastAssistant = -1
        let lastText = ''
        for (let i = 0; i < tail.length; i += 1) {
          const message = tail[i]
          if (!message) {
            continue
          }
          if (message.role === 'user') {
            lastUser = i
          } else if (message.role === 'assistant') {
            const text = messageText(message).trim()
            if (text) {
              lastAssistant = i
              lastText = text
            }
          }
        }
        if (lastAssistant > lastUser && lastText) {
          const already = chat.messages.some(
            message => message.role === 'assistant' && message.text === lastText
          )
          if (!already) {
            chat.messages.push({ role: 'assistant', text: lastText })
          }
          chat.streaming = ''
          chat.busy = false
          chat.status = ''
          emitDiscuss()
        }
      } catch {
        /* the next tick retries */
      }
    }
    const timer = window.setInterval(() => void reconcile(), 5000)
    void reconcile()
    return () => {
      alive = false
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, chat?.busy])

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [chat?.messages.length, chat?.streaming, chat?.busy])

  if (!chat) {
    return jsx('div', {
      style: { padding: '12px', color: 'var(--ui-text-secondary)', fontSize: '12px' },
      children: 'This side chat is no longer available.'
    })
  }

  const canSend = !chat.busy && input.trim().length > 0
  const canCopy =
    !chat.busy &&
    handoff.status !== 'working' &&
    chat.messages.some(message => message.role === 'assistant')
  const managerState = discussByParent.get(chat.parentKey)
  const managerRows = Array.from(discussRegistry.values())
    .filter(record => record.parentKey === chat.parentKey)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  async function openManagerRow(record) {
    setManagerBusy(`${record.childStoredId}:open`)
    setManagerError('')
    try {
      const state = discussByParent.get(chat.parentKey)
      const full =
        state && Array.isArray(state.sessions)
          ? state.sessions.find(item => item.childStoredId === record.childStoredId)
          : null
      await continueDiscuss(full ? { ...record, ...full } : record)
      setManagerOpen(false)
    } catch (err) {
      setManagerError((err && err.message) || 'Could not open the side chat')
    } finally {
      setManagerBusy('')
    }
  }

  async function hideManagerRow(record) {
    setManagerBusy(`${record.childStoredId}:hide`)
    setManagerError('')
    try {
      await host.request(
        'session.set_hidden',
        { session_id: record.childStoredId, hidden: true },
        60000
      )
      record.hidden = true
      saveDiscussStore()
      saveDiscussRegistry()
      emitDiscuss()
    } catch (err) {
      setManagerError((err && err.message) || 'Could not archive the side chat')
    } finally {
      setManagerBusy('')
    }
  }

  async function deleteManagerRow(record) {
    if (!window.confirm(`Delete "${record.title || 'this side chat'}"? This cannot be undone.`)) {
      return
    }
    setManagerBusy(`${record.childStoredId}:delete`)
    setManagerError('')
    try {
      await host
        .request('session.close', { session_id: record.childRuntimeId }, 60000)
        .catch(() => undefined)
      await host.request('session.delete', { session_id: record.childStoredId }, 60000)
      const state = discussByParent.get(record.parentKey)
      if (state) {
        state.sessions = state.sessions.filter(
          item => item.childStoredId !== record.childStoredId
        )
        if (state.active && state.active.childStoredId === record.childStoredId) {
          state.active = state.sessions[0] || null
        }
        discussByParent.set(record.parentKey, state)
        saveDiscussStore()
      }
      discussRegistry.delete(record.childStoredId)
      saveDiscussRegistry()
      emitDiscuss()
    } catch (err) {
      setManagerError((err && err.message) || 'Could not delete the side chat')
    } finally {
      setManagerBusy('')
    }
  }

  async function hideOldChats() {
    const state = discussByParent.get(chat.parentKey)
    if (!state) {
      return
    }
    const activeId = state.active ? state.active.childStoredId : ''
    setManagerBusy('hide-all')
    setManagerError('')
    try {
      for (const record of managerRows) {
        if (record.childStoredId === activeId) {
          continue
        }
        await host
          .request(
            'session.set_hidden',
            { session_id: record.childStoredId, hidden: true },
            60000
          )
          .catch(() => undefined)
        record.hidden = true
      }
      saveDiscussStore()
      saveDiscussRegistry()
      emitDiscuss()
    } finally {
      setManagerBusy('')
    }
  }

  async function copyHandoff() {
    if (!chat || !canCopy) {
      return
    }
    const transcript = chat.messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.text}`)
      .join('\n\n')
      .trim()
    if (!transcript) {
      return
    }
    setHandoff({ status: 'working', error: '' })
    try {
      const res = await host.request(
        'llm.oneshot',
        {
          session_id: chatId,
          instructions: HANDOFF_INSTRUCTIONS,
          input: transcript.slice(0, 16000),
          max_tokens: 600,
          temperature: 0.2,
          task: 'title_generation'
        },
        90000
      )
      const summary = res && typeof res.text === 'string' ? res.text.trim() : ''
      if (!summary) {
        throw new Error('The summary came back empty')
      }
      const text = [
        'The user asked a side session about this. The side session advised the following. The user has not necessarily agreed to it. Before acting, confirm the next steps with the user, ideally with a Hermes questionnaire.',
        '',
        'SIDE SESSION SUMMARY',
        summary,
        '',
        'STATUS',
        'No user agreement was recorded in this side session unless DECISIONS says otherwise.',
        '',
        'SIDE DISCUSSION TRANSCRIPT',
        transcript.slice(0, 20000)
      ].join('\n')
      await writeClipboardText(text)
      setHandoff({ status: 'copied', error: '' })
      window.setTimeout(() => setHandoff({ status: 'idle', error: '' }), 2200)
    } catch (err) {
      setHandoff({
        status: 'idle',
        error: (err && err.message) || 'Could not copy the handoff'
      })
    }
  }

  async function loadLatestSummary(target) {
    if (!target || target.summaryLoading || target.latestSummary) {
      return
    }
    target.summaryLoading = true
    emitDiscuss()
    try {
      const res = await host.request(
        'llm.oneshot',
        {
          session_id: target.parentSessionId,
          instructions: INSTRUCTIONS,
          input: target.latestReply.slice(0, MAX_INPUT),
          max_tokens: 260,
          temperature: 0.2,
          task: 'title_generation'
        },
        90000
      )
      const summary = res && typeof res.text === 'string' ? res.text.trim() : ''
      target.latestSummary = summary || 'No summary available.'
      if (summary && target.parentKey) {
        const key = `${target.parentKey}\u0000${hashText(target.latestReply)}`
        cache[key] = { summary, at: Date.now() }
        writeCache()
      }
    } catch {
      target.latestSummary = 'Could not summarise the latest reply.'
    }
    target.summaryLoading = false
    emitDiscuss()
  }

  async function loadRecap(target) {
    if (!target || target.recapLoading || target.recap || !target.seedTranscript) {
      return
    }
    target.recapLoading = true
    emitDiscuss()
    try {
      const res = await host.request(
        'llm.oneshot',
        {
          session_id: target.parentSessionId,
          instructions: RECAP_FINAL_INSTRUCTIONS,
          input: target.seedTranscript,
          max_tokens: RECAP_FINAL_TOKENS,
          temperature: 0.2,
          task: 'title_generation'
        },
        90000
      )
      const text = res && typeof res.text === 'string' ? res.text.trim() : ''
      target.recap = text || 'No catch-up available.'
    } catch {
      target.recap = 'Could not build the catch-up.'
    }
    target.recapLoading = false
    emitDiscuss()
  }

  async function changeModel(value) {
    const option = models.options.find(item => item.value === value)
    if (!option) {
      return
    }
    setModels(state => ({ ...state, switching: true, error: '', value }))
    try {
      await host.request(
        'config.set',
        {
          key: 'model',
          value: `${option.model} --provider ${option.provider}`,
          session_id: chatId,
          confirm_expensive_model: true
        },
        120000
      )
      setModels(state => ({ ...state, switching: false, label: option.label }))
    } catch (err) {
      setModels(state => ({
        ...state,
        switching: false,
        error: (err && err.message) || 'Could not switch model'
      }))
    }
  }

  function send() {
    const text = input.trim()
    if (!text || chat.busy) {
      return
    }
    setInput('')
    chat.messages.push({ role: 'user', text })
    chat.busy = true
    chat.streaming = ''
    chat.error = ''
    chat.status = 'Thinking…'
    emitDiscuss()
    host
      .request(
        'prompt.submit',
        { session_id: chatId, text: `${DISCUSSION_PREFIX}${text}` },
        120000
      )
      .catch(err => {
        chat.busy = false
        chat.status = ''
        chat.error = (err && err.message) || 'Could not send'
        emitDiscuss()
      })
  }

  return jsxs('div', {
    style: paneWrap,
    children: [
      jsxs('div', {
        style: paneHeader,
        children: [
          jsx('span', { style: paneTitle, children: 'Discuss' }),
          jsx('span', {
            style: paneMeta,
            children: chat.contextCount ? `${chat.contextCount} messages of context` : 'Side chat'
          })
        ]
      }),
      jsxs('div', {
        style: contextCard,
        children: [
          jsxs('div', {
            style: contextHead,
            onClick: () => setContextOpen(value => !value),
            children: [
              jsx('span', { style: contextLabel, children: 'Session context' }),
              jsx('span', { style: { flex: 1 } }),
              jsx('span', {
                style: { color: 'var(--ui-text-tertiary)', fontSize: '10px' },
                children: contextOpen ? '▾' : '▸'
              })
            ]
          }),
          contextOpen
            ? jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: '6px' },
                children: [
                  chat.latestReply
                    ? jsxs('div', {
                        style: contextSection,
                        children: [
                          jsx('span', { style: contextLabel, children: 'Latest reply' }),
                          jsx('div', {
                            'data-selectable-text': 'true',
                            style: { ...contextText, maxHeight: '72px' },
                            children:
                              chat.latestSummary ||
                              (chat.summaryLoading ? 'Summarising…' : 'No summary yet.')
                          })
                        ]
                      })
                    : null,
                  chat.recap || chat.recapLoading || chat.seedTranscript
                    ? jsxs('div', {
                        style: contextSection,
                        children: [
                          jsx('span', { style: contextLabel, children: 'Catch-up' }),
                          jsx('div', {
                            'data-selectable-text': 'true',
                            style: {
                              ...contextText,
                              maxHeight: recapExpanded ? '220px' : '84px'
                            },
                            children:
                              chat.recap ||
                              (chat.recapLoading
                                ? 'Building a concise catch-up…'
                                : 'No catch-up yet.')
                          }),
                          chat.recap && chat.recap.length > 160
                            ? jsx('button', {
                                type: 'button',
                                style: contextMore,
                                onClick: () => setRecapExpanded(value => !value),
                                children: recapExpanded ? 'Less' : 'More'
                              })
                            : null
                        ]
                      })
                    : null
                ]
              })
            : null
        ]
      }),
      jsxs('div', {
        ref: scrollRef,
        style: paneThread,
        children: [
          jsx('div', {
            style: paneNote,
            children:
              "Seeded from the main session's current context. The main chat is untouched. Discussion-only; answers from the context, no tool calls."
          }),
          ...chat.messages.map((message, index) =>
            jsx(
              'div',
              {
                'data-selectable-text': 'true',
                style: message.role === 'user' ? userBubble : assistantBubble,
                children: message.text
              },
              index
            )
          ),
          chat.streaming
            ? jsx('div', {
                'data-selectable-text': 'true',
                style: assistantBubble,
                children: chat.streaming
              })
            : null,
          chat.busy && !chat.streaming
            ? jsx('div', { style: paneMeta, children: chat.status || 'Thinking…' })
            : null,
          chat.error ? jsx('div', { style: paneError, children: chat.error }) : null
        ]
      }),
      handoff.error ? jsx('div', { style: paneError, children: handoff.error }) : null,
      jsx('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          flexShrink: 0
        },
        children: jsx('button', {
          type: 'button',
          style: { ...discussPill, padding: '3px 8px' },
          onClick: () => setManagerOpen(true),
          children: `Side chats (${managerRows.length} total)`
        })
      }),
      models.switching ? jsx('div', { style: paneMeta, children: 'Switching model…' }) : null,
      models.error ? jsx('div', { style: paneError, children: models.error }) : null,
      jsxs('div', {
        style: composerBox,
        children: [
          jsx(Textarea, {
            value: input,
            onChange: event => setInput(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            },
            onPaste: event => {
              const text = event.clipboardData && event.clipboardData.getData('text/plain')
              if (text) {
                event.preventDefault()
                setInput(value => `${value}${text}`)
              }
            },
            placeholder: 'Ask about the decisions, risks, or next steps…',
            rows: 2,
            className:
              'min-h-0 resize-none border-0 bg-transparent text-xs shadow-none focus-visible:ring-0'
          }),
          jsxs('div', {
            style: composerFooter,
            children: [
              jsx(Select, {
                value: models.value,
                onValueChange: value => void changeModel(value),
                disabled: models.loading || models.switching,
                children: [
                  jsx(SelectTrigger, {
                    className:
                      'h-6 w-52 border-0 bg-transparent px-1 text-[10px] shadow-none',
                    children: jsx(SelectValue, {
                      placeholder: models.loading ? 'Loading models…' : 'Model'
                    })
                  }),
                  jsx(SelectContent, {
                    children: models.options.map(option =>
                      jsx(SelectItem, {
                        value: option.value,
                        children: option.label
                      }, option.value)
                    )
                  })
                ]
              }),
              jsx('span', { style: { flex: 1 } }),
              jsx(Button, {
                size: 'sm',
                variant: 'secondary',
                onClick: () => void copyHandoff(),
                disabled: !canCopy,
                title: 'Copy a summary of this side discussion for the main chat',
                children:
                  handoff.status === 'working'
                    ? 'Copying…'
                    : handoff.status === 'copied'
                      ? 'Copied'
                      : 'Copy'
              }),
              jsx(Button, {
                size: 'sm',
                onClick: send,
                disabled: !canSend,
                children: chat.busy ? 'Working…' : 'Send'
              })
            ]
          })
        ]
      }),
      managerOpen
        ? jsx(Dialog, {
            open: true,
            onOpenChange: open => {
              if (!open) {
                setManagerOpen(false)
              }
            },
            children: jsx(DialogContent, {
              className: 'max-w-lg',
              children: jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: '10px' },
                children: [
                  jsxs(DialogHeader, {
                    children: [
                      jsx(DialogTitle, { children: 'Side chats' }),
                      jsx(DialogDescription, {
                        children:
                          'Open, archive, or delete side chats for this main session. New side chats are hidden from the main sessions list.'
                      })
                    ]
                  }),
                  managerError ? jsx('div', { style: paneError, children: managerError }) : null,
                  jsxs('div', {
                    style: { display: 'flex', gap: '6px' },
                    children: [
                      jsx(Button, {
                        size: 'sm',
                        onClick: () => {
                          setManagerOpen(false)
                          void createDiscuss()
                        },
                        disabled: Boolean(managerBusy),
                        children: 'New side chat'
                      }),
                      jsx(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        onClick: () => void hideOldChats(),
                        disabled: Boolean(managerBusy),
                        children: 'Hide all old'
                      })
                    ]
                  }),
                  managerRows.length
                    ? jsx('div', {
                        style: managerList,
                        children: managerRows.map(record => {
                          const active =
                            managerState &&
                            managerState.active &&
                            managerState.active.childStoredId === record.childStoredId
                          return jsxs(
                            'div',
                            {
                              style: managerRow,
                              children: [
                                jsxs('div', {
                                  style: { flex: 1, minWidth: 0 },
                                  children: [
                                    jsx('div', {
                                      style: managerTitle,
                                      children: record.title || 'Discuss'
                                    }),
                                    jsx('div', {
                                      style: managerMeta,
                                      children: `${record.initialCount || 0} context · ${
                                        record.model || 'inherited model'
                                      }${record.hidden ? ' · archived' : ''}${
                                        active ? ' · active' : ''
                                      }`
                                    })
                                  ]
                                }),
                                jsx(Button, {
                                  size: 'sm',
                                  variant: 'ghost',
                                  disabled: Boolean(managerBusy),
                                  onClick: () => void openManagerRow(record),
                                  children: active ? 'Open' : 'Switch'
                                }),
                                jsx(Button, {
                                  size: 'sm',
                                  variant: 'ghost',
                                  disabled: Boolean(managerBusy),
                                  onClick: () => void hideManagerRow(record),
                                  children: 'Hide'
                                }),
                                jsx(Button, {
                                  size: 'sm',
                                  variant: 'ghost',
                                  disabled: Boolean(managerBusy),
                                  onClick: () => void deleteManagerRow(record),
                                  children: 'Delete'
                                })
                              ]
                            },
                            record.childStoredId
                          )
                        })
                      })
                    : jsx('div', { style: paneMeta, children: 'No side chats yet.' }),
                  jsxs(DialogFooter, {
                    children: [
                      jsx(Button, {
                        variant: 'ghost',
                        onClick: () => setManagerOpen(false),
                        children: 'Close'
                      })
                    ]
                  })
                ]
              })
            })
          })
        : null
    ]
  })
}

function DiscussLauncher() {
  useSyncExternalStore(subscribeDiscussUi, discussUiSnapshot, discussUiSnapshot)
  const sessionId = useValue(host.state.focusedSessionId)
  if (!sessionId) {
    return null
  }
  const dialog = discussUi.dialog
  if (!dialog) {
    return null
  }
  return jsx(Dialog, {
    open: true,
    onOpenChange: open => {
      if (!open) {
        closeDiscussDialog()
      }
    },
    children: jsx(DialogContent, {
      className: 'max-w-md',
      children: jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px' },
        children: [
          jsxs(DialogHeader, {
            children: [
              jsx(DialogTitle, { children: 'Side chat already exists' }),
              jsx(DialogDescription, {
                children:
                  'Continue the existing discussion, or start a new side chat with a fresh copy of this session.'
              })
            ]
          }),
          jsx('div', {
            style: {
              fontSize: '11px',
              color: 'var(--ui-text-secondary)',
              lineHeight: 1.5
            },
            children: `${dialog.record.initialCount || 0} messages of context · started ${new Date(
              dialog.record.createdAt || Date.now()
            ).toLocaleDateString()}`
          }),
          discussUi.error ? jsx('div', { style: paneError, children: discussUi.error }) : null,
          jsxs(DialogFooter, {
            children: [
              jsx(Button, {
                variant: 'ghost',
                onClick: closeDiscussDialog,
                children: 'Cancel'
              }),
              jsx(Button, {
                variant: 'secondary',
                onClick: () => void createDiscuss(),
                disabled: discussUi.busy,
                children: 'Start new'
              }),
              jsx(Button, {
                onClick: () => void continueDiscuss(dialog.record),
                disabled: discussUi.busy,
                children: discussUi.busy ? 'Opening…' : 'Continue existing'
              })
            ]
          })
        ]
      })
    })
  })
}

function Bubble() {
  const sessionId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId)
  const profile = useValue(host.state.focusedSessionProfile)
  const busy = useValue(host.state.busy)
  useSyncExternalStore(subscribe, snapshot, snapshot)
  useSyncExternalStore(subscribeDiscussUi, discussUiSnapshot, discussUiSnapshot)

  const [state, setState] = useState({ sessionId: null, text: '', key: '', status: 'idle', summary: '', error: '' })
  const [expanded, setExpanded] = useState(true)
  const [recap, setRecap] = useState({
    sessionId: null,
    status: 'idle',
    text: '',
    error: '',
    progress: '',
    key: '',
    count: 0
  })
  const [recapOpen, setRecapOpen] = useState(false)
  const seq = useRef(0)
  const recapSeq = useRef(0)
  const loadedFor = useRef(null)
  const processedKey = useRef('')

  const scopeKey = `${profile || ''}\u0000${storedId || sessionId || ''}`

  // A session change retires any recap from the previous chat.
  useEffect(() => {
    recapSeq.current += 1
    setRecap({ sessionId: null, status: 'idle', text: '', error: '', progress: '', key: '', count: 0 })
    setRecapOpen(false)
  }, [sessionId])

  function finish(sid, text) {
    const key = `${scopeKey}\u0000${hashText(text)}`
    if (processedKey.current === key) {
      return
    }
    processedKey.current = key
    if (text.length < MIN_LEN) {
      setState({ sessionId: sid, text: '', key: '', status: 'idle', summary: '', error: '' })
      return
    }
    const hit = cache[key]
    if (hit && typeof hit.summary === 'string' && hit.summary.trim()) {
      setState({ sessionId: sid, text, key, status: 'ready', summary: hit.summary.trim(), error: '' })
      return
    }
    void summarise(sid, text, key)
  }

  async function summarise(sid, text, key) {
    const my = ++seq.current
    setState({ sessionId: sid, text, key, status: 'loading', summary: '', error: '' })
    try {
      const res = await host.request(
        'llm.oneshot',
        {
          session_id: sid,
          instructions: INSTRUCTIONS,
          input: text.slice(0, MAX_INPUT),
          max_tokens: 260,
          temperature: 0.2,
          task: 'title_generation'
        },
        90000
      )
      const summary = res && typeof res.text === 'string' ? res.text.trim() : ''
      if (!summary) {
        throw new Error('empty summary')
      }
      cache[key] = { summary, at: Date.now() }
      writeCache()
      if (my === seq.current) {
        setState({ sessionId: sid, text, key, status: 'ready', summary, error: '' })
      }
    } catch (err) {
      if (my === seq.current) {
        setState({
          sessionId: sid,
          text,
          key,
          status: 'error',
          summary: '',
          error: (err && err.message) || 'Could not summarise'
        })
      }
    }
  }

  async function generateRecap() {
    if (!sessionId) {
      return
    }
    const my = ++recapSeq.current
    setRecapOpen(true)
    setRecap({
      sessionId,
      status: 'loading',
      text: '',
      error: '',
      progress: 'Reading the session…',
      key: '',
      count: 0
    })
    try {
      const hist = await host.request('session.history', { session_id: sessionId })
      if (my !== recapSeq.current) {
        return
      }
      const messages = (hist && hist.messages) || []
      const transcript = buildTranscript(messages)
      if (!transcript.trim()) {
        throw new Error('Nothing to summarise yet')
      }
      const key = `${scopeKey}\u0000${RECAP_PROMPT_VERSION}\u0000${messages.length}\u0000${hashText(transcript)}`
      const hit = recapCache[key]
      if (hit && typeof hit.text === 'string' && hit.text.trim()) {
        setRecap({
          sessionId,
          status: 'ready',
          text: hit.text.trim(),
          error: '',
          progress: '',
          key,
          count: messages.length
        })
        return
      }

      const allChunks = chunkTranscript(transcript, RECAP_CHUNK_CHARS)
      const selected =
        allChunks.length > MAX_RECAP_CHUNKS
          ? [allChunks[0], ...allChunks.slice(allChunks.length - (MAX_RECAP_CHUNKS - 1))]
          : allChunks
      const omitted = allChunks.length - selected.length
      const parts = new Array(selected.length).fill('')
      let done = 0
      const results = await Promise.allSettled(
        selected.map(async (chunk, index) => {
          const res = await host.request(
            'llm.oneshot',
            {
              session_id: sessionId,
              instructions: RECAP_PART_INSTRUCTIONS,
              input: chunk,
              max_tokens: RECAP_PART_TOKENS,
              temperature: 0.2,
              task: 'title_generation'
            },
            90000
          )
          const part = res && typeof res.text === 'string' ? res.text.trim() : ''
          if (part) {
            parts[index] = part
          }
          done += 1
          if (my === recapSeq.current) {
            setRecap(r => ({ ...r, progress: `Read ${done} of ${selected.length} parts…` }))
          }
        })
      )
      if (my !== recapSeq.current) {
        return
      }
      if (results.every(result => result.status === 'rejected')) {
        const reason = results[0] && results[0].reason
        throw reason instanceof Error ? reason : new Error('The recap came back empty')
      }
      const summaries = parts.filter(Boolean)
      if (!summaries.length) {
        throw new Error('The recap came back empty')
      }
      setRecap(r => ({ ...r, progress: 'Writing the recap…' }))
      const res = await host.request(
        'llm.oneshot',
        {
          session_id: sessionId,
          instructions: RECAP_FINAL_INSTRUCTIONS,
          input: summaries.join('\n\n---\n\n').slice(0, 16000),
          max_tokens: RECAP_FINAL_TOKENS,
          temperature: 0.2,
          task: 'title_generation'
        },
        90000
      )
      let text = res && typeof res.text === 'string' ? res.text.trim() : ''
      if (!text) {
        throw new Error('The recap came back empty')
      }
      if (omitted > 0) {
        text += `\n\n(${omitted} earlier part${omitted === 1 ? '' : 's'} condensed to keep the cost bounded.)`
      }
      recapCache[key] = { text, at: Date.now(), count: messages.length }
      writeRecapCache()
      if (my === recapSeq.current) {
        setRecap({
          sessionId,
          status: 'ready',
          text,
          error: '',
          progress: '',
          key,
          count: messages.length
        })
      }
    } catch (err) {
      if (my === recapSeq.current) {
        setRecap({
          sessionId,
          status: 'error',
          text: '',
          error: (err && err.message) || 'Could not build the recap',
          progress: '',
          key: '',
          count: 0
        })
      }
    }
  }

  function toggleRecap(event) {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation()
    }
    if (recap.status === 'loading') {
      return
    }
    if (recap.status === 'ready' && recap.sessionId === sessionId) {
      setRecapOpen(v => !v)
      return
    }
    void generateRecap()
  }

  function refreshRecap(event) {
    event.stopPropagation()
    if (recap.key) {
      delete recapCache[recap.key]
      writeRecapCache()
    }
    void generateRecap()
  }

  function closeRecap(event) {
    event.stopPropagation()
    setRecapOpen(false)
  }

  // A new live completion for this session always wins over the history read.
  useEffect(() => {
    if (!sessionId) {
      setState({ sessionId: null, text: '', key: '', status: 'idle', summary: '', error: '' })
      processedKey.current = ''
      loadedFor.current = null
      return
    }
    if (busy) {
      // Keep the last summary and its controls visible while the next turn
      // runs: Catch up and Discuss are most useful mid-turn.
      loadedFor.current = null
      return
    }
    const live = latestBySession.get(sessionId)
    if (live && typeof live.text === 'string' && live.text.length >= MIN_LEN) {
      finish(sessionId, live.text)
      return
    }
    if (loadedFor.current === sessionId) {
      return
    }
    loadedFor.current = sessionId
    let alive = true
    host
      .request('session.history', { session_id: sessionId })
      .then(res => {
        if (!alive) {
          return
        }
        const text = lastAssistantText(res && res.messages)
        if (text) {
          finish(sessionId, text)
        } else {
          setState({ sessionId, text: '', key: '', status: 'idle', summary: '', error: '' })
        }
      })
      .catch(() => {
        if (alive) {
          setState({ sessionId, text: '', key: '', status: 'idle', summary: '', error: '' })
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, busy, version, scopeKey])

  if (!sessionId || state.sessionId !== sessionId || state.status === 'idle') {
    return null
  }

  function toggle() {
    setExpanded(v => !v)
  }

  function refresh(event) {
    event.stopPropagation()
    if (!state.key || !state.text) {
      return
    }
    delete cache[state.key]
    writeCache()
    processedKey.current = state.key
    void summarise(state.sessionId, state.text, state.key)
  }

  const statusText =
    state.status === 'loading'
      ? 'Summarising this reply…'
      : state.status === 'error'
        ? state.error || 'Summary unavailable'
        : state.summary

  const showRecap = recapOpen && recap.sessionId === sessionId && recap.status !== 'idle'

  return jsxs('div', {
    'data-plugin': ID,
    style: wrap,
    children: [
      showRecap
        ? jsxs('div', {
            style: recapPanel,
            children: [
              jsxs('div', {
                style: recapHead,
                children: [
                  jsx('span', { style: { color: 'var(--ui-accent)', fontSize: '12px' }, children: '▤' }),
                  jsx('span', { style: recapTitle, children: 'Session recap' }),
                  jsx('span', {
                    style: recapMeta,
                    children:
                      recap.status === 'loading'
                        ? 'Working…'
                        : recap.status === 'error'
                          ? 'Failed'
                          : `${recap.count} messages`
                  }),
                  jsx('span', { style: { flex: 1 } }),
                  recap.status === 'ready'
                    ? jsx('button', {
                        type: 'button',
                        title: 'Open a side chat to discuss this recap',
                        style: summaryPill,
                        onClick: event => {
                          event.stopPropagation()
                          requestDiscuss()
                        },
                        disabled: discussUi.busy,
                        children: discussUi.busy ? 'Opening…' : 'Discuss'
                      })
                    : null,
                  recap.status === 'loading'
                    ? null
                    : jsx('button', {
                        type: 'button',
                        title: 'Regenerate session recap',
                        'aria-label': 'Regenerate session recap',
                        style: iconButton,
                        onClick: refreshRecap,
                        children: '↻'
                      }),
                  jsx('button', {
                    type: 'button',
                    title: 'Close session recap',
                    'aria-label': 'Close session recap',
                    style: iconButton,
                    onClick: closeRecap,
                    children: '×'
                  })
                ]
              }),
              recap.status === 'loading'
                ? jsx('div', { style: { ...muted, fontSize: '11px' }, children: recap.progress })
                : recap.status === 'error'
                  ? jsx('div', { style: { ...muted, fontSize: '11px' }, children: recap.error })
                  : jsx('div', { style: recapBody, children: recapLines(recap.text) })
            ]
          })
        : null,
      jsxs('div', {
        role: 'button',
        tabIndex: 0,
        title: expanded ? 'Collapse summary' : 'Expand summary',
        style: head,
        onClick: toggle,
        onKeyDown: e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        },
        children: [
          jsx('span', { style: { color: 'var(--ui-accent)', fontSize: '12px' }, children: '✦' }),
          jsx('span', { style: label, children: 'Summary' }),
          jsx('span', {
            style: { color: 'var(--ui-text-tertiary)', fontSize: '10px' },
            children: expanded ? '▾' : '▸'
          }),
          jsx('span', { style: { flex: 1 } }),
          jsxs('div', {
            style: iconStack,
            children: [
              jsx('button', {
                type: 'button',
                title:
                  recap.status === 'loading'
                    ? 'Building session recap…'
                    : recap.status === 'ready' && recapOpen
                      ? 'Hide session recap'
                      : 'Catch up on the whole session',
                'aria-label':
                  recap.status === 'loading'
                    ? 'Building session recap…'
                    : recap.status === 'ready' && recapOpen
                      ? 'Hide session recap'
                      : 'Catch up on the whole session',
                style: {
                  ...summaryPill,
                  color:
                    recap.status === 'ready' && recapOpen
                      ? 'var(--ui-accent)'
                      : 'var(--ui-text-primary)'
                },
                onClick: toggleRecap,
                children:
                  recap.status === 'loading'
                    ? 'Building…'
                    : recap.status === 'ready' && recapOpen
                      ? 'Hide'
                      : 'Catch up'
              }),
              jsx('button', {
                type: 'button',
                title: 'Open a side chat to discuss this session',
                style: summaryPill,
                onClick: event => {
                  event.stopPropagation()
                  requestDiscuss()
                },
                disabled: discussUi.busy,
                children: discussUi.busy ? 'Opening…' : 'Discuss'
              }),
              jsx('button', {
                type: 'button',
                title: 'Regenerate summary',
                'aria-label': 'Regenerate summary',
                style: iconButton,
                onClick: event => {
                  event.stopPropagation()
                  refresh()
                },
                children: '↻'
              })
            ]
          })
        ]
      }),
      jsx('div', {
        style: state.status === 'loading' || state.status === 'error' ? muted : expanded ? bodyExpanded : bodyCollapsed,
        children: statusText
      }),
      discussUi.error
        ? jsx('div', {
            style: { color: 'var(--ui-red)', fontSize: '10px', lineHeight: 1.4 },
            children: discussUi.error
          })
        : null
    ]
  })
}

export default {
  id: ID,
  name: 'Answer Summary',
  description: 'AI recaps of the latest reply and the whole session, above the composer.',
  defaultEnabled: true,
  register(ctx) {
    ctx.onEvent('message.complete', event => {
      const sid = event && event.session_id
      const payload = (event && event.payload) || {}
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!sid || !text) {
        return
      }
      latestBySession.set(sid, { text, at: Date.now() })
      if (latestBySession.size > 24) {
        const oldest = [...latestBySession.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) {
          latestBySession.delete(oldest[0])
        }
      }
      emit()
    })

    // Side-chat streams. Only sessions registered by Discuss are tracked, so
    // the main chat's own events pass through untouched.
    ctx.onEvent('message.delta', event => {
      const chat = discussChats.get(event && event.session_id)
      if (!chat) {
        return
      }
      const text = event.payload && typeof event.payload.text === 'string' ? event.payload.text : ''
      if (!text) {
        return
      }
      chat.streaming += text
      chat.busy = true
      chat.status = ''
      emitDiscuss()
    })

    ctx.onEvent('message.complete', event => {
      const chat = discussChats.get(event && event.session_id)
      if (!chat) {
        return
      }
      const payload = (event && event.payload) || {}
      const final = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (final) {
        chat.messages.push({ role: 'assistant', text: final })
      } else if (chat.streaming.trim()) {
        chat.messages.push({ role: 'assistant', text: chat.streaming.trim() })
      }
      chat.streaming = ''
      chat.busy = false
      chat.status = ''
      if (payload.error) {
        chat.error = String(payload.error)
      }
      emitDiscuss()
    })

    ctx.onEvent('tool.start', event => {
      const chat = discussChats.get(event && event.session_id)
      if (!chat) {
        return
      }
      const name = event.payload && event.payload.name ? event.payload.name : 'a tool'
      chat.status = `Using ${name}…`
      emitDiscuss()
    })

    ctx.onEvent('tool.complete', event => {
      const chat = discussChats.get(event && event.session_id)
      if (!chat) {
        return
      }
      chat.status = ''
      emitDiscuss()
    })

    ctx.register({
      id: 'bubble',
      area: COMPOSER_AREAS.top,
      render: () => jsx(Bubble, {})
    })

    ctx.register({
      id: 'discuss-launcher',
      area: COMPOSER_AREAS.bottom,
      render: () => jsx(DiscussLauncher, {})
    })
  }
}
