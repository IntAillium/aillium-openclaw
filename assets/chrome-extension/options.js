import { DEFAULT_AILLIUM_SERVER, deriveRelayToken, hostedConnectUrl } from './background-utils.js'
import { classifyRelayCheckException, classifyRelayCheckResponse } from './options-validation.js'

const DEFAULT_PORT = 18792

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://127.0.0.1:${port}/`
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(port, token) {
  const url = `http://127.0.0.1:${port}/json/version`
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Gateway token required. Save your gateway token to connect.')
    return
  }
  try {
    const relayToken = await deriveRelayToken(trimmedToken, port)
    // Delegate the fetch to the background service worker to bypass
    // CORS preflight on the custom x-openclaw-relay-token header.
    const res = await chrome.runtime.sendMessage({
      type: 'relayCheck',
      url,
      token: relayToken,
    })
    const result = classifyRelayCheckResponse(res, port)
    if (result.action === 'throw') throw new Error(result.error)
    setStatus(result.kind, result.message)
  } catch (err) {
    const result = classifyRelayCheckException(err, port)
    setStatus(result.kind, result.message)
  }
}

function setHostedStatus(kind, message) {
  const status = document.getElementById('hosted-status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function refreshHostedStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'ailliumStatus' }).catch(() => null)
  if (!res?.hosted) {
    setHostedStatus('', 'Not connected to Aillium yet.')
  } else if (res.stopped) {
    setHostedStatus('error', 'Stopped. Aillium cannot use this browser until you let it.')
  } else if (res.connected) {
    setHostedStatus('ok', `Connected to Aillium${res.tabs ? ` · working in ${res.tabs} tab${res.tabs === 1 ? '' : 's'}` : ''}.`)
  } else {
    setHostedStatus('', 'Connecting… If this stays, check the pairing code in Aillium Settings.')
  }
}

async function connectHosted() {
  const pairing = String(document.getElementById('pairing').value || '').trim()
  const server = String(document.getElementById('server').value || '').trim() || DEFAULT_AILLIUM_SERVER
  try {
    if (pairing) hostedConnectUrl(server, pairing)
  } catch (err) {
    setHostedStatus('error', err instanceof Error ? err.message : String(err))
    return
  }
  await chrome.storage.local.set({ pairingCode: pairing, ailliumServer: server, ailliumStopped: false })
  if (!pairing) {
    setHostedStatus('', 'Pairing code removed.')
    return
  }
  setHostedStatus('', 'Connecting…')
  await chrome.runtime.sendMessage({ type: 'ailliumReconnect' }).catch(() => null)
  setTimeout(() => void refreshHostedStatus(), 1500)
}

async function load() {
  const hosted = await chrome.storage.local.get(['pairingCode', 'ailliumServer'])
  document.getElementById('pairing').value = String(hosted.pairingCode || '')
  document.getElementById('server').value = String(hosted.ailliumServer || DEFAULT_AILLIUM_SERVER)
  await refreshHostedStatus()
  const stored = await chrome.storage.local.get(['relayPort', 'gatewayToken'])
  const port = clampPort(stored.relayPort)
  const token = String(stored.gatewayToken || '').trim()
  document.getElementById('port').value = String(port)
  document.getElementById('token').value = token
  updateRelayUrl(port)
  if (!hosted.pairingCode) await checkRelayReachable(port, token)
}

async function save() {
  const portInput = document.getElementById('port')
  const tokenInput = document.getElementById('token')
  const port = clampPort(portInput.value)
  const token = String(tokenInput.value || '').trim()
  await chrome.storage.local.set({ relayPort: port, gatewayToken: token })
  portInput.value = String(port)
  tokenInput.value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

document.getElementById('save').addEventListener('click', () => void save())
document.getElementById('connect').addEventListener('click', () => void connectHosted())
document.getElementById('stop').addEventListener('click', () =>
  void chrome.runtime.sendMessage({ type: 'ailliumStop' }).then(() => refreshHostedStatus()),
)
document.getElementById('resume').addEventListener('click', () =>
  void chrome.runtime.sendMessage({ type: 'ailliumResume' }).then(() => setTimeout(() => void refreshHostedStatus(), 1500)),
)
void load()
