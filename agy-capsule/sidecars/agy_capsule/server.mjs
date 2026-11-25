import { createSidebarHtml, PANEL_VERSION } from './sidebar_ui.mjs';
import { parseGenRow, parseUsageRow, readConversationSnapshot, readConversationUsage } from './conversation_db.mjs';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDeckInjector } from './deck_injector.mjs';
import { createSettingsStore } from './settings.mjs';
import { createPresentation } from './ui.mjs';
import { summarizeGeneration } from './metrics.mjs';
import { classifyRequestError } from './errors.mjs';
import { createSqliteSnapshotCache } from './sqlite_cache.mjs';
import { startLsWatchdog } from './ls_watchdog.mjs';
import { loopbackFetch } from './loopback_fetch.mjs';
import { startSelfReloadWatcher } from './reload.mjs';
import { installAsyncHostRoutes, installEpipeGuard } from './host_bridge.mjs';
import { createCdpNoticeManager } from './cdp_notice.mjs';
import { createCloudTelemetryStore } from './cloud_telemetry.mjs';
import { createUsageHistory } from './usage_history.mjs';
import { CURRENT_VERSION, RELEASES_URL, VERSION_ROUTE, createVersionChecker } from './version_check.mjs';
import { createPluginUpdater, UPDATE_ROUTE } from './version_update.mjs';

const settingsStore = createSettingsStore();
const checkVersion = createVersionChecker({ getPrefs: () => settingsStore.read() });
const updatePlugin = createPluginUpdater({ sidecarDirectory: dirname(fileURLToPath(import.meta.url)), checkVersion });
const cloudTelemetryStore = createCloudTelemetryStore();
const diagnosticSystem = [process.platform, release().match(/^\d+(?:\.\d+)*/)?.[0]].filter(Boolean).join(' ');
const presentation = createPresentation();
export function getNotifyText(shortcutState, prefs) {
  const t = presentation.dictionaries[prefs?.settingsLanguage] || presentation.dictionaries['zh-CN'];
  if (shortcutState === 'S5') return { title: t.healthSidebarTitle, body: t.healthS5 };
  return { title: t.cdpNotifyTitle, body: shortcutState === 'missing' ? t.cdpNotifyBodyMissing : t.cdpNotifyBodyOk };
}
const cdpNotice = createCdpNoticeManager({ getPrefs: () => settingsStore.read(), getNotifyText });

function conversationDirectories(dataDir) {
  if (dataDir) {
    // The host passes <appData>/sidecar_data/<plugin>/<sidecar>/data.
    const root = resolve(dataDir);
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
      if (basename(dir) === 'sidecar_data') return [join(dirname(dir), 'conversations')];
    }
    return [join(root, 'conversations')]; // An explicitly supplied app data root.
  }
  return ['antigravity', 'antigravity-ide', 'antigravity-cli'].map(product =>
    join(homedir(), '.gemini', product, 'conversations'));
}
const conversationDirs = conversationDirectories(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);

const NO_QUOTA = { quotaGroups: [], cloudPaygo: false, hideQuota: false };
let cachedQuota = null;
let lastQuotaFetchMs = 0;
const QUOTA_TTL_MS = 10000;
let quotaPromise = null;

async function fetchQuota(refresh = false) {
  if (!refresh) {
    return cachedQuota || NO_QUOTA;
  }
  if (quotaPromise) return quotaPromise;
  quotaPromise = loadQuota();
  try { return await quotaPromise; }
  finally { quotaPromise = null; }
}

async function loadQuota() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return cachedQuota || NO_QUOTA;
  const request = method => loopbackFetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  try {
    const res = await request('RetrieveUserQuotaSummary');
    if (!res.ok) return cachedQuota || NO_QUOTA;
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return cachedQuota || NO_QUOTA;
    const groups = data?.response?.groups ?? data?.groups;
    const quotaGroups = Array.isArray(groups) ? groups : [];
    let cloudPaygo = false;
    if (quotaGroups.length === 0) {
      // A missing summary alone is not a billing-mode signal. The local user
      // status identifies Cloud pay-as-you-go separately from subscriptions.
      cloudPaygo = cachedQuota?.cloudPaygo ?? false;
      try {
        const status = await request('GetUserStatus');
        if (status.ok) cloudPaygo = (await status.json())?.userStatus?.userTier?.id === 'agy-business-paygo-tier';
      } catch {} // Optional detection must not restart the sidecar.
    }
    cachedQuota = { quotaGroups, cloudPaygo, hideQuota: quotaGroups.length === 0 };
    lastQuotaFetchMs = Date.now();
    return cachedQuota;
  } catch {
    return cachedQuota || NO_QUOTA;
  }
}

let lastDeckConvId = null; // '' when on New Conversation page, or uuid when on /c/<uuid>

function resolveConversationDb(id, allowLatest) {
  if (id) {
    if (typeof id !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(id)) return null;
    for (const dir of conversationDirs) {
      const path = join(dir, `${id}.db`);
      if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path;
    }
    return null;
  }
  // Before a composer selects a chat, the sidebar may follow the newest DB
  // in one product only. Check at read time: a fresh profile may not exist yet.
  if (!allowLatest) return null;
  const dir = conversationDirs.find(path => statSync(path, { throwIfNoEntry: false })?.isDirectory());
  if (!dir) return null;
  let latest = null, newest = -Infinity;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const path = join(dir, file);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.mtimeMs > newest) { latest = path; newest = stat.mtimeMs; }
  }
  return latest;
}

async function makeEmptyContextResult(health = null, { refreshQuota = false } = {}) {
  return {
    health,
    uiVersion: PANEL_VERSION,
    turnSpeed: null,
    turnQueue: null,
    turnMetrics: null,
    requestError: classifyRequestError(),
    generation: summarizeGeneration(),
    prefs: settingsStore.read(),
    cachedIn: 0,
    uncachedIn: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    lastStepEpochMs: 0,
    turn0Tokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    ...await fetchQuota(refreshQuota),
  };
}

const ACTIVE_CONV_TTL_MS = 60_000;
const recentActiveConversations = new Map();
function touchActiveConversation(id) {
  if (typeof id === 'string' && /^[0-9a-zA-Z_-]+$/.test(id)) {
    const now = Date.now();
    recentActiveConversations.set(id, now);
    if (recentActiveConversations.size > 16) {
      const cutoff = now - ACTIVE_CONV_TTL_MS;
      for (const [entryId, seenAt] of recentActiveConversations) {
        if (seenAt < cutoff) recentActiveConversations.delete(entryId);
      }
    }
  }
}
function getActiveConversationIds() {
  const cutoff = Date.now() - ACTIVE_CONV_TTL_MS;
  for (const [id, seenAt] of recentActiveConversations) {
    if (seenAt < cutoff) recentActiveConversations.delete(id);
  }
  const active = new Set(recentActiveConversations.keys());
  if (lastDeckConvId) active.add(lastDeckConvId);
  return [...active];
}

async function inspectConversation(convId, exact = false, subagentOnly = false, estimate = null, options = {}) {
  if (exact && !subagentOnly) lastDeckConvId = convId || '';
  if (subagentOnly && !convId) return null;
  return readSelectedConversation(subagentOnly ? convId : lastDeckConvId ?? convId,
    !subagentOnly && lastDeckConvId === null, subagentOnly, estimate, options);
}

async function readSelectedConversation(convId, allowLatest, subagentOnly = false, estimate = null, { refreshQuota = false } = {}) {
  touchActiveConversation(convId);
  const dbPath = resolveConversationDb(convId, allowLatest);
  if (subagentOnly && !dbPath) return null;
  const prefs = settingsStore.read();
  if (!dbPath) {
    const cloudSnapshot = cloudTelemetryStore.read(convId, prefs.showTurnMetrics);
    if (cloudSnapshot) {
      return {
        health: null,
        uiVersion: PANEL_VERSION,
        ...cloudSnapshot,
        ...(estimate && { contextEstimate: estimate }),
        prefs,
        ...await fetchQuota(refreshQuota),
      };
    }
    const empty = await makeEmptyContextResult(conversationDirs.some(dir => statSync(dir, { throwIfNoEntry: false })?.isDirectory()) ? null : { code: 'S3' }, { refreshQuota });
    return estimate ? { ...empty, contextEstimate: estimate } : empty;
  }
  touchActiveConversation(basename(dbPath, '.db'));

  const snapshot = conversationCache.read(dbPath, prefs.showTurnMetrics);
  // 'side': a full conversation shown in a side chat tab. Render it through the
  // child-strip path, mounted inside the native footer (native model picker stays).
  const side = subagentOnly === 'side';
  if (side && !snapshot) return null;
  if (subagentOnly && !side && !snapshot?.subagent) return null;
  const health = conversationCache.health(dbPath);
  if (!snapshot) {
    const empty = await makeEmptyContextResult(health, { refreshQuota });
    return estimate ? { ...empty, contextEstimate: estimate } : empty;
  }
  // Prefer a newer measured request if SQLite has already caught up, even
  // when the renderer is still holding the preceding compaction update.
  const showEstimate = estimate && !snapshot.subagent && !(snapshot.contextRequestIndex > estimate.generatorMetadataIndex);
  return {
    health,
    uiVersion: PANEL_VERSION,
    ...snapshot,
    ...(showEstimate && { contextEstimate: estimate }),
    ...(side && { subagent: { model: '', side: true } }),
    prefs,
    ...(subagentOnly && !side ? NO_QUOTA : await fetchQuota(refreshQuota)),
  };
}

const conversationCache = createSqliteSnapshotCache(readConversationSnapshot);

const usageHistory = createUsageHistory({
  directories: conversationDirs,
  readRequests: readConversationUsage,
  getActiveIds: getActiveConversationIds,
});

// Conversations are scanned only while a setting shows their history.
async function inspectUsage(prefs = settingsStore.read(), activeConversationId = '') {
  if (prefs.showUsageActivity !== true && prefs.showModelUsage !== true) return { enabled: false };
  return { enabled: true, ...await usageHistory.read({ activeId: activeConversationId }) };
}

const UI_HTML = createSidebarHtml({ version: CURRENT_VERSION, releasesUrl: RELEASES_URL, versionRoute: VERSION_ROUTE,
  updateRoute: UPDATE_ROUTE, diagnosticSystem });

const rememberCloudTelemetry = cloudTelemetryStore.set;
export { inspectConversation, inspectUsage, UI_HTML, parseGenRow, parseUsageRow, readConversationSnapshot, readConversationUsage, rememberCloudTelemetry };

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) installEpipeGuard();
let deckInjector = null;
export async function startPanel(loadSdk = () => import('sidecar_sdk'), env = process.env, notices = cdpNotice) {
  // The SDK skips authentication for GET, and for every method without a UI token.
  // Do not start its listener (including built-in host routes) in the latter case.
  if (!env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
    console.error('[agy-capsule] sidebar disabled: host did not supply a UI token');
    await notices.notifyPanelUnavailable();
    return;
  }
  const { SidecarApp } = await loadSdk();
  const app = new SidecarApp();
  app.page('/', () => UI_HTML);
  app.page('/ui.html', () => UI_HTML);
  // A panel left open during update reads this version even on HTTP 405, then reloads.
  app.api('/api/context', () => ({ status: 405, headers: { Allow: 'POST' }, contentType: 'application/json',
    body: JSON.stringify({ uiVersion: PANEL_VERSION }) }), 'GET');
  app.api('/api/context', async (data) => {
    const deckCdp = deckInjector?.status?.() ?? 'unknown';
    // Full View changes the sidecar's conversation; opening a child tab
    // beside its parent does not. Neither should depend on the last CDP footer.
    const conversationId = data?.conversationId ?? app.config?.conversationId ?? '';
    const refreshQuota = data?.refreshQuota === true;
    return {
      ...await readSelectedConversation(conversationId, false, false, deckInjector?.contextEstimate(conversationId), { refreshQuota }),
      deckCdp,
      deckCdpInfo: cdpNotice.info(deckCdp),
      availableModels: deckInjector?.models?.(conversationId) ?? [],
    };
  }, 'POST');
  app.api('/api/usage', (data) => inspectUsage(settingsStore.read(), data?.conversationId ?? app.config?.conversationId ?? ''), 'POST');
  app.api('/api/settings', (data) => settingsStore.update(data), 'POST');
  app.api(VERSION_ROUTE, data => checkVersion(data?.mode), 'POST');
  app.api(UPDATE_ROUTE, data => updatePlugin(data?.version), 'POST');
  app.api('/api/fix-cdp-shortcut', () => cdpNotice.fixShortcuts(), 'POST');
  const ready = app.run();
  installAsyncHostRoutes(app);
  await ready;
  return app;
}
if (isMain && (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT)) {
  const injector = deckInjector = startDeckInjector(inspectConversation, {
    productRoots: conversationDirs.map(dir => dirname(dir)),
    needsCloudTelemetry: convId => !resolveConversationDb(convId, false),
    onCloudTelemetry: rememberCloudTelemetry,
    onStatus: state => cdpNotice.observe(state),
    onEffortSettingsPatch: patch => settingsStore.update(patch),
    sideChatEnabled: () => settingsStore.read().showSideChatCapsules === true,
  });
  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopLsWatchdog();
    stopWatching();
    console.log('[agy-capsule] restarting/stopping:', reason);
    try { await injector.stop(); }
    finally { process.exit(0); }
  };
  const stopWatching = startSelfReloadWatcher(dirname(fileURLToPath(import.meta.url)), () => void shutdown('plugin files changed'));
  const stopLsWatchdog = startLsWatchdog(process.env.ANTIGRAVITY_LS_ADDRESS, shutdown);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) await startPanel();
}
