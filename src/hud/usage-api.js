/**
 * HUD - Usage API
 *
 * Fetches rate limit usage from Anthropic's OAuth API.
 * Based on claude-hud implementation by jarrodwatts.
 *
 * Authentication:
 * - macOS: Reads from Keychain "Claude Code-credentials"
 * - Linux/fallback: Reads from ~/.claude/.credentials.json
 *
 * API: api.anthropic.com/api/oauth/usage
 * Response: { five_hour: { utilization }, seven_day: { utilization }, limits: [...] }
 *
 * Credentials are strictly read-only. In particular the HUD never refreshes an
 * expired access token: OAuth refresh tokens are single-use, so a refresh from
 * a statusline hook revokes the token Claude Code itself holds and forces a
 * re-login (anthropics/claude-code#42603, closed with "remove all token refresh
 * logic from hooks"). Claude Code refreshes on its own and rewrites the store;
 * the HUD just re-reads it.
 */
import { existsSync, readFileSync } from 'fs';
import { getClaudeConfigDir } from '../lib/config-dir.js';
import { getCacheDir } from '../lib/worktree-paths.js';
import { join } from 'path';
import { atomicWriteFileSync, atomicWriteJsonSync } from '../lib/atomic-write.js';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { userInfo } from 'os';
import { DEFAULT_HUD_USAGE_POLL_INTERVAL_MS, } from './types.js';
import { readHudConfig } from './state.js';
import { lockPathFor, withFileLock } from '../lib/file-lock.js';
// Cache configuration
const CACHE_TTL_FAILURE_MS = 15 * 1000; // 15 seconds for non-transient failures
const CACHE_TTL_TRANSIENT_NETWORK_MS = 2 * 60 * 1000; // 2 minutes to avoid hammering transient API failures
const MAX_RATE_LIMITED_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max for sustained 429s
const API_TIMEOUT_MS = 10000;
const MAX_STALE_DATA_MS = 15 * 60 * 1000; // 15 minutes — discard stale data after this
const USAGE_CACHE_LOCK_OPTS = { staleLockMs: API_TIMEOUT_MS + 5000 };
// `https` and `crypto` load at their point of use: almost every frame is a
// usage-cache hit that needs neither, and loading them costs ~10 ms (measured,
// Node 24). `require('https')` is the same CJS object statusline.mjs patches
// for the proxy tunnel. No `node:` prefix: require() takes it only from 14.18.
const require = createRequire(import.meta.url);
function isEnterpriseUsageContext(options) {
    if (!options)
        return true;
    const subscriptionType = options.subscriptionType?.toLowerCase() ?? null;
    const rateLimitTier = options.rateLimitTier ?? null;
    if (subscriptionType == null && rateLimitTier == null)
        return true;
    return subscriptionType === 'enterprise' || /claude_zero/i.test(rateLimitTier ?? '');
}
/**
 * Check if a URL points to Anthropic's own API (exact host or subdomain).
 *
 * The OAuth usage endpoint (api.anthropic.com/api/oauth/usage) describes the
 * Claude *subscription* tied to the local OAuth token, regardless of where
 * ANTHROPIC_BASE_URL sends model traffic. So it is only meaningful when traffic
 * actually goes to Anthropic — base URL unset or an *.anthropic.com host.
 */
export function isAnthropicHost(urlString) {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        return hostname === 'anthropic.com' || hostname.endsWith('.anthropic.com');
    }
    catch {
        return false;
    }
}
/**
 * Get the legacy (pre-split) cache file path.
 *
 * Lives at the cache root (not a per-session subfolder): the usage cache is
 * shared across all sessions — one rate-limit backoff state per account.
 */
function getLegacyCachePath() {
    return join(getCacheDir(), '.usage-cache.json');
}
/**
 * Get the provider-specific cache file path. Shared across sessions, so it sits
 * at the cache root alongside `.last-prune` — the pattern-specific pruner in
 * statusline.sh never matches `.usage-cache-*.json`, so it is not evicted.
 */
function getCachePath(source) {
    return join(getCacheDir(), `.usage-cache-${source}.json`);
}
/**
 * Migrate legacy single-file cache to provider-specific file.
 * One-shot: only runs when the provider-specific file does not yet exist
 * and the legacy cache's source matches the current provider.
 * Does NOT delete the legacy file (rolling update safety).
 */
function migrateLegacyCache(source) {
    try {
        const legacyPath = getLegacyCachePath();
        if (!existsSync(legacyPath))
            return;
        // One-shot guard: skip if new file already exists
        if (existsSync(getCachePath(source)))
            return;
        const content = readFileSync(legacyPath, 'utf-8');
        const cache = JSON.parse(content);
        // Source mismatch guard: only migrate if legacy cache belongs to this provider
        if (cache.source !== source)
            return;
        // Atomic write (creates the parent dir itself).
        atomicWriteFileSync(getCachePath(source), content);
    }
    catch {
        // Best-effort migration — failures are harmless
    }
}
/**
 * Read cached usage data for a specific provider
 */
function readCache(source) {
    try {
        const cachePath = getCachePath(source);
        if (!existsSync(cachePath))
            return null;
        const content = readFileSync(cachePath, 'utf-8');
        const cache = JSON.parse(content);
        // Re-hydrate Date objects from JSON strings
        if (cache.data) {
            if (cache.data.fiveHourResetsAt) {
                cache.data.fiveHourResetsAt = new Date(cache.data.fiveHourResetsAt);
            }
            if (cache.data.weeklyResetsAt) {
                cache.data.weeklyResetsAt = new Date(cache.data.weeklyResetsAt);
            }
            if (cache.data.sonnetWeeklyResetsAt) {
                cache.data.sonnetWeeklyResetsAt = new Date(cache.data.sonnetWeeklyResetsAt);
            }
            if (cache.data.opusWeeklyResetsAt) {
                cache.data.opusWeeklyResetsAt = new Date(cache.data.opusWeeklyResetsAt);
            }
            if (cache.data.monthlyResetsAt) {
                cache.data.monthlyResetsAt = new Date(cache.data.monthlyResetsAt);
            }
            if (cache.data.extraUsageResetsAt) {
                cache.data.extraUsageResetsAt = new Date(cache.data.extraUsageResetsAt);
            }
            if (Array.isArray(cache.data.modelWeekly)) {
                for (const bucket of cache.data.modelWeekly) {
                    if (bucket && bucket.resetsAt) {
                        bucket.resetsAt = new Date(bucket.resetsAt);
                    }
                }
            }
        }
        return cache;
    }
    catch {
        return null;
    }
}
/**
 * Write usage data to cache (provider-specific file)
 */
function writeCache(opts) {
    try {
        const cachePath = getCachePath(opts.source);
        const cache = {
            timestamp: Date.now(),
            data: opts.data,
            error: opts.error,
            errorReason: opts.errorReason,
            source: opts.source,
            rateLimited: opts.rateLimited || undefined,
            rateLimitedCount: opts.rateLimitedCount && opts.rateLimitedCount > 0 ? opts.rateLimitedCount : undefined,
            rateLimitedUntil: opts.rateLimitedUntil,
            lastSuccessAt: opts.lastSuccessAt,
        };
        // Atomic write: this file is shared across sessions and read on an
        // unlocked fast path, so a torn read must never be possible.
        atomicWriteJsonSync(cachePath, cache);
    }
    catch {
        // Ignore cache write errors
    }
}
/**
 * Check if cache is still valid
 */
// Floor for usageApiPollIntervalMs. The endpoint answers 429 to a few fetches
// a minute (seen while testing), and a 1 s floor allowed one per render.
const MIN_POLL_INTERVAL_MS = 30 * 1000;
function sanitizePollIntervalMs(value) {
    if (value == null || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
    }
    return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value));
}
function getUsagePollIntervalMs() {
    try {
        return sanitizePollIntervalMs(readHudConfig().usageApiPollIntervalMs);
    }
    catch {
        return DEFAULT_HUD_USAGE_POLL_INTERVAL_MS;
    }
}
function getRateLimitedBackoffMs(pollIntervalMs, count) {
    const normalizedPollIntervalMs = sanitizePollIntervalMs(pollIntervalMs);
    return Math.min(normalizedPollIntervalMs * Math.pow(2, Math.max(0, count - 1)), MAX_RATE_LIMITED_BACKOFF_MS);
}
function getTransientNetworkBackoffMs(pollIntervalMs) {
    return Math.max(CACHE_TTL_TRANSIENT_NETWORK_MS, sanitizePollIntervalMs(pollIntervalMs));
}
function isCacheValid(cache, pollIntervalMs) {
    if (cache.rateLimited) {
        if (cache.rateLimitedUntil != null) {
            return Date.now() < cache.rateLimitedUntil;
        }
        const count = cache.rateLimitedCount || 1;
        return Date.now() - cache.timestamp < getRateLimitedBackoffMs(pollIntervalMs, count);
    }
    const ttl = cache.error
        ? cache.errorReason === 'network'
            ? getTransientNetworkBackoffMs(pollIntervalMs)
            : CACHE_TTL_FAILURE_MS
        : sanitizePollIntervalMs(pollIntervalMs);
    return Date.now() - cache.timestamp < ttl;
}
function hasUsableStaleData(cache) {
    if (!cache?.data) {
        return false;
    }
    if (cache.lastSuccessAt && Date.now() - cache.lastSuccessAt > MAX_STALE_DATA_MS) {
        return false;
    }
    return true;
}
function getCachedUsageResult(cache) {
    if (cache.rateLimited) {
        if (!hasUsableStaleData(cache) && cache.data) {
            return { rateLimits: null, error: 'rate_limited' };
        }
        return { rateLimits: cache.data, error: 'rate_limited', stale: cache.data ? true : undefined };
    }
    if (cache.error) {
        const errorReason = cache.errorReason || 'network';
        if (hasUsableStaleData(cache)) {
            return { rateLimits: cache.data, error: errorReason, stale: true };
        }
        return { rateLimits: null, error: errorReason };
    }
    return { rateLimits: cache.data };
}
function createRateLimitedCacheEntry(source, data, pollIntervalMs, previousCount, lastSuccessAt) {
    const timestamp = Date.now();
    const rateLimitedCount = previousCount + 1;
    return {
        timestamp,
        data,
        error: false,
        errorReason: 'rate_limited',
        source,
        rateLimited: true,
        rateLimitedCount,
        rateLimitedUntil: timestamp + getRateLimitedBackoffMs(pollIntervalMs, rateLimitedCount),
        lastSuccessAt,
    };
}
/**
 * Get the Keychain service name for the current config directory.
 * Claude Code uses "Claude Code-credentials-{sha256(configDir)[:8]}" for
 * non-default dirs, where configDir is derived from the exact
 * CLAUDE_CONFIG_DIR value rather than the expanded filesystem path. Preserve
 * that behavior so ~-prefixed profiles keep matching Claude Code's own
 * Keychain entries.
 */
function getKeychainServiceName() {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir) {
        const hash = require('crypto').createHash('sha256').update(configDir).digest('hex').slice(0, 8);
        return `Claude Code-credentials-${hash}`;
    }
    return 'Claude Code-credentials';
}
function isCredentialExpired(creds) {
    return creds.expiresAt != null && creds.expiresAt <= Date.now();
}
function readKeychainCredential(serviceName, account) {
    try {
        const args = account
            ? ['find-generic-password', '-s', serviceName, '-a', account, '-w']
            : ['find-generic-password', '-s', serviceName, '-w'];
        const result = execFileSync('/usr/bin/security', args, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!result)
            return null;
        const parsed = JSON.parse(result);
        // Handle nested structure (claudeAiOauth wrapper)
        const creds = parsed.claudeAiOauth || parsed;
        if (!creds.accessToken)
            return null;
        return {
            accessToken: creds.accessToken,
            expiresAt: creds.expiresAt,
            source: 'keychain',
            subscriptionType: creds.subscriptionType,
            rateLimitTier: creds.rateLimitTier,
        };
    }
    catch {
        return null;
    }
}
/**
 * Read OAuth credentials from macOS Keychain
 */
function readKeychainCredentials() {
    if (process.platform !== 'darwin')
        return null;
    const serviceName = getKeychainServiceName();
    const candidateAccounts = [];
    try {
        const username = userInfo().username?.trim();
        if (username) {
            candidateAccounts.push(username);
        }
    }
    catch {
        // Best-effort only; fall back to the legacy service-only lookup below.
    }
    candidateAccounts.push(undefined);
    let expiredFallback = null;
    for (const account of candidateAccounts) {
        const creds = readKeychainCredential(serviceName, account);
        if (!creds)
            continue;
        if (!isCredentialExpired(creds)) {
            return creds;
        }
        if (expiredFallback === null)
            expiredFallback = creds; // not `??=`: that is Node 15+ syntax, and the floor is 14.17
    }
    return expiredFallback;
}
/**
 * Read OAuth credentials from file fallback
 */
function readFileCredentials() {
    try {
        const credPath = join(getClaudeConfigDir(), '.credentials.json');
        if (!existsSync(credPath))
            return null;
        const content = readFileSync(credPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Handle nested structure (claudeAiOauth wrapper)
        const creds = parsed.claudeAiOauth || parsed;
        if (creds.accessToken) {
            return {
                accessToken: creds.accessToken,
                expiresAt: creds.expiresAt,
                source: 'file',
                subscriptionType: creds.subscriptionType,
                rateLimitTier: creds.rateLimitTier,
            };
        }
    }
    catch {
        // File read failed
    }
    return null;
}
/**
 * Get OAuth credentials (Keychain first, then file fallback)
 */
function getCredentials() {
    // Try Keychain first (macOS)
    const keychainCreds = readKeychainCredentials();
    if (keychainCreds)
        return keychainCreds;
    // Fall back to file
    return readFileCredentials();
}
/**
 * Validate credentials are not expired
 */
function validateCredentials(creds) {
    if (!creds.accessToken)
        return false;
    return !isCredentialExpired(creds);
}
/**
 * Fetch usage from Anthropic API
 */
/**
 * @param accessToken OAuth access token
 * @param budgetMs    0 = no budget. Otherwise give up after this many ms and
 *                    resolve `{ overBudget: true }` — the caller's cue to leave
 *                    the cache alone (see getUsage).
 */
function fetchUsageFromApi(accessToken, budgetMs) {
    return new Promise((settle) => {
        let budgetTimer = null;
        let deadlineTimer = null;
        let settled = false;
        const resolve = (result) => {
            if (settled)
                return;
            settled = true;
            if (budgetTimer)
                clearTimeout(budgetTimer);
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            settle(result);
        };
        const req = require('https').request({
            hostname: 'api.anthropic.com',
            path: '/api/oauth/usage',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            timeout: API_TIMEOUT_MS,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            // A body cut off mid-way (proxy reset, tunnel teardown) never
            // emits 'end', and `req` reports no 'error' once a response
            // exists: without these the promise never settled, Node exited
            // with no line, and the lock was left behind.
            res.on('error', () => resolve({ data: null }));
            res.on('close', () => {
                if (!res.complete)
                    resolve({ data: null });
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve({ data: JSON.parse(data) });
                    }
                    catch {
                        resolve({ data: null });
                    }
                }
                else if (res.statusCode === 429) {
                    if (process.env.HUD_DEBUG) {
                        console.error(`[usage-api] Anthropic API returned 429 (rate limited)`);
                    }
                    resolve({ data: null, rateLimited: true });
                }
                else {
                    resolve({ data: null });
                }
            });
        });
        req.on('error', () => resolve({ data: null }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ data: null });
        });
        if (budgetMs > 0) {
            budgetTimer = setTimeout(() => {
                // Settle first: destroy() emits 'error', whose { data: null }
                // must not be the result.
                resolve({ data: null, overBudget: true });
                req.destroy();
            }, budgetMs);
        }
        // Wall-clock cap. The `timeout` option is a socket-*idle* timer, so a
        // response trickling a byte every few seconds never trips it and held
        // the usage lock indefinitely. API_TIMEOUT_MS stays under the lock's
        // staleLockMs, so a live holder never outlasts the staleness window.
        deadlineTimer = setTimeout(() => {
            resolve({ data: null });
            req.destroy();
        }, API_TIMEOUT_MS);
        req.end();
    });
}
/**
 * Clamp values to 0-100 and filter invalid
 */
function clamp(v) {
    if (v == null || !isFinite(v))
        return 0;
    return Math.max(0, Math.min(100, v));
}
/**
 * Short label for a model-scoped weekly bucket: the first letter plus the
 * first consonant after it, so the labels the HUD always used fall out of
 * the rule (Sonnet → `sn`, Opus → `op`) and new models get one too (Fable →
 * `fb`). The name is server-supplied text; only ASCII letters survive, so no
 * control or escape byte can reach the line. Null when none are left (a
 * name in another script): that bucket is skipped.
 */
export function modelWeeklyLabel(displayName) {
    if (typeof displayName !== 'string')
        return null;
    // Drop CSI/OSC escapes whole first, or their final byte (`m` of `ESC[31m`)
    // would be read as a letter of the name.
    const letters = displayName
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
    if (!letters)
        return null;
    const consonant = letters.slice(1).match(/[^aeiou]/);
    return letters[0] + (consonant ? consonant[0] : letters.slice(1, 2));
}
// At most this many extra per-model buckets reach the line.
const MAX_MODEL_WEEKLY = 4;
/**
 * Parse API response into RateLimits
 *
 * The flat buckets (`five_hour`, `seven_day`, `seven_day_sonnet`,
 * `seven_day_opus`) come first. The newer `limits[]` list is the fallback:
 * `session` / `weekly_all` stand in for an absent five-hour / seven-day
 * window, and every `weekly_scoped` entry naming a model becomes a per-model
 * weekly bucket — on current accounts the flat per-model fields are null and
 * the per-model caps (Fable, say) exist only there. Sonnet and Opus fill
 * the existing `sn:`/`op:` slots; any other model goes to `modelWeekly`.
 */
export function parseUsageResponse(response, options) {
    // `null`, an array or a scalar is valid JSON too; reading a bucket off
    // `null` would throw.
    if (!response || typeof response !== 'object' || Array.isArray(response))
        return null;
    const limits = Array.isArray(response.limits)
        ? response.limits.filter((l) => l && typeof l === 'object' && typeof l.percent === 'number' && isFinite(l.percent))
        : [];
    const unscopedLimit = (kind) => limits.find((l) => l.kind === kind && l.scope == null);
    const sessionLimit = response.five_hour?.utilization == null ? unscopedLimit('session') : undefined;
    const weeklyAllLimit = response.seven_day?.utilization == null ? unscopedLimit('weekly_all') : undefined;
    const fiveHour = response.five_hour?.utilization ?? sessionLimit?.percent;
    const sevenDay = response.seven_day?.utilization ?? weeklyAllLimit?.percent;
    // Model-scoped weekly entries, by label. A surface-scoped entry (a cap on
    // one client, not one model) is skipped rather than mislabeled as a model.
    const scoped = new Map();
    for (const l of limits) {
        if (l.kind !== 'weekly_scoped' || !l.scope || typeof l.scope !== 'object' || l.scope.surface != null)
            continue;
        const label = modelWeeklyLabel(l.scope.model?.display_name);
        if (!label)
            continue;
        const prev = scoped.get(label);
        if (!prev || l.percent > prev.percent)
            scoped.set(label, l);
    }
    const sonnetScoped = response.seven_day_sonnet?.utilization == null ? scoped.get('sn') : undefined;
    const opusScoped = response.seven_day_opus?.utilization == null ? scoped.get('op') : undefined;
    const sonnetSevenDay = response.seven_day_sonnet?.utilization ?? sonnetScoped?.percent;
    const opusSevenDay = response.seven_day_opus?.utilization ?? opusScoped?.percent;
    scoped.delete('sn');
    scoped.delete('op');
    // `is_enabled: false` means no extra usage is set up, whatever else the
    // object holds.
    const extra = response.extra_usage?.is_enabled === false ? null : response.extra_usage;
    const usedCredits = extra?.used_credits;
    const extraCurrency = (extra?.currency ?? 'USD').toUpperCase();
    const isEnterpriseContext = isEnterpriseUsageContext(options);
    // used_credits are only usable when we know how to interpret the minor-unit digits;
    // see the USD guards in the extra_usage branch below for rationale.
    const hasUsableUsedCredits = usedCredits != null && extraCurrency === 'USD';
    const hasUsableEnterprise = isEnterpriseContext && hasUsableUsedCredits;
    const hasUsableUsdExtraUsage = extra?.limit_usd != null && extra.limit_usd > 0;
    const hasUsableCreditExtraUsage = !isEnterpriseContext && hasUsableUsedCredits && extra?.monthly_limit != null && extra.monthly_limit > 0;
    const hasUsableExtraUsage = hasUsableUsdExtraUsage || hasUsableCreditExtraUsage;
    // Need at least one valid value. Model-specific weekly buckets are valid usage data
    // even when generic subscription/window metadata is absent or nullish.
    if (fiveHour == null &&
        sevenDay == null &&
        sonnetSevenDay == null &&
        opusSevenDay == null &&
        scoped.size === 0 &&
        !hasUsableEnterprise &&
        !hasUsableExtraUsage)
        return null;
    // Parse ISO 8601 date strings to Date objects
    const parseDate = (dateStr) => {
        if (!dateStr)
            return null;
        try {
            const date = new Date(dateStr);
            return isNaN(date.getTime()) ? null : date;
        }
        catch {
            return null;
        }
    };
    const result = {};
    // Only the windows the API reported: clamp(undefined) is 0, so an
    // unconditional assignment invented `5h:0%` for an account without a
    // five-hour window (enterprise, or model-scoped buckets only).
    if (fiveHour != null) {
        result.fiveHourPercent = clamp(fiveHour);
        result.fiveHourResetsAt = parseDate(sessionLimit ? sessionLimit.resets_at : response.five_hour?.resets_at);
    }
    if (sevenDay != null) {
        result.weeklyPercent = clamp(sevenDay);
        result.weeklyResetsAt = parseDate(weeklyAllLimit ? weeklyAllLimit.resets_at : response.seven_day?.resets_at);
    }
    if (sonnetSevenDay != null) {
        result.sonnetWeeklyPercent = clamp(sonnetSevenDay);
        result.sonnetWeeklyResetsAt = parseDate(sonnetScoped ? sonnetScoped.resets_at : response.seven_day_sonnet?.resets_at);
    }
    if (opusSevenDay != null) {
        result.opusWeeklyPercent = clamp(opusSevenDay);
        result.opusWeeklyResetsAt = parseDate(opusScoped ? opusScoped.resets_at : response.seven_day_opus?.resets_at);
    }
    if (scoped.size > 0) {
        result.modelWeekly = Array.from(scoped, ([label, l]) => ({
            label,
            percent: clamp(l.percent),
            resetsAt: parseDate(l.resets_at),
        })).slice(0, MAX_MODEL_WEEKLY);
    }
    // Add extra (metered) usage if available (Pro subscribers with extra usage allocation)
    if (extra != null) {
        // Enterprise path: used_credits (minor units) is present instead of spent_usd/limit_usd.
        // Only USD is observed in practice; the /100 divisor below assumes 2-digit minor units.
        // For any non-USD currency we refuse to guess the minor-unit digit count (JPY/KRW are
        // 0-digit, TND/BHD are 3-digit per ISO 4217).
        const currency = (extra.currency ?? 'USD').toUpperCase();
        if (extra.used_credits != null && currency === 'USD' && isEnterpriseContext) {
            // Enterprise spend is deliberately not rendered (the enterprise-cost
            // element was pruned), but the branch must stay so enterprise
            // used_credits are never misread as Pro/Max "extra:" overage below.
        }
        else if (extra.used_credits != null && currency === 'USD' && !isEnterpriseContext && extra.monthly_limit != null && extra.monthly_limit > 0) {
            // Max/Pro organization overage path: the API can use the enterprise-shaped
            // used_credits/monthly_limit fields even though the account should still render
            // normal token-window limits. Treat those minor-unit values as extra usage.
            const spentUsd = extra.used_credits / 100;
            result.extraUsageSpentUsd = spentUsd;
            result.extraUsageLimitUsd = extra.monthly_limit / 100;
            result.extraUsagePercent = extra.utilization != null
                ? clamp(extra.utilization)
                : clamp((extra.used_credits / extra.monthly_limit) * 100);
            result.extraUsageResetsAt = parseDate(extra.resets_at);
        }
        else if (extra.limit_usd != null && extra.limit_usd > 0) {
            // Pro metered path
            const spentUsd = extra.spent_usd ?? 0;
            result.extraUsageSpentUsd = spentUsd;
            result.extraUsageLimitUsd = extra.limit_usd;
            // Use API-provided utilization when available; fall back to spent/limit ratio
            result.extraUsagePercent = extra.utilization != null
                ? clamp(extra.utilization)
                : clamp((spentUsd / extra.limit_usd) * 100);
            result.extraUsageResetsAt = parseDate(extra.resets_at);
        }
    }
    return result;
}
/**
 * Generic provider fetch-and-cache cycle.
 * Handles 429 backoff, stale data fallback, and cache writes.
 * Provider-specific pre-fetch logic (e.g., credential refresh) runs before calling this.
 */
async function fetchAndCacheUsage(opts) {
    const { source, fetchFn, parseFn, cache, pollIntervalMs } = opts;
    const result = await fetchFn();
    if (result.overBudget) {
        // Not a failure: the API was never given its full timeout. Writing the
        // 'network' entry here would suppress fetches for the 2-minute
        // transient backoff; leave the cache as it was so the next unbudgeted
        // render fetches, and serve what it holds meanwhile.
        if (cache?.data && hasUsableStaleData(cache)) {
            return { rateLimits: cache.data, stale: true };
        }
        return { rateLimits: null };
    }
    if (result.rateLimited) {
        const prevLastSuccess = cache?.lastSuccessAt;
        const rateLimitedCache = createRateLimitedCacheEntry(source, cache?.data || null, pollIntervalMs, cache?.rateLimitedCount || 0, prevLastSuccess);
        writeCache({
            data: rateLimitedCache.data,
            error: rateLimitedCache.error,
            source,
            rateLimited: true,
            rateLimitedCount: rateLimitedCache.rateLimitedCount,
            rateLimitedUntil: rateLimitedCache.rateLimitedUntil,
            errorReason: 'rate_limited',
            lastSuccessAt: rateLimitedCache.lastSuccessAt,
        });
        if (rateLimitedCache.data) {
            if (prevLastSuccess && Date.now() - prevLastSuccess > MAX_STALE_DATA_MS) {
                return { rateLimits: null, error: 'rate_limited' };
            }
            return { rateLimits: rateLimitedCache.data, error: 'rate_limited', stale: true };
        }
        return { rateLimits: null, error: 'rate_limited' };
    }
    if (!result.data) {
        const fallbackData = hasUsableStaleData(cache) ? cache.data : null;
        writeCache({
            data: fallbackData,
            error: true,
            source,
            errorReason: 'network',
            lastSuccessAt: cache?.lastSuccessAt,
        });
        if (fallbackData) {
            return { rateLimits: fallbackData, error: 'network', stale: true };
        }
        return { rateLimits: null, error: 'network' };
    }
    let usage = null;
    try {
        usage = parseFn(result.data);
    }
    catch {
        // Treated as unusable below, like a null parse.
    }
    if (!usage) {
        // A 200 the parser cannot use (shape drift, a proxy or captive portal
        // answering 200) is a failure like any other: keep the last good
        // numbers and their lastSuccessAt, and back off for the transient
        // TTL. Writing `data: null` with no reason wiped the cache and
        // re-polled every 15 s.
        if (process.env.HUD_DEBUG) {
            const keys = result.data && typeof result.data === 'object' ? Object.keys(result.data).join(',') : typeof result.data;
            console.error(`[usage-api] unusable 200 response; top-level keys: ${keys}`);
        }
        const fallbackData = hasUsableStaleData(cache) ? cache.data : null;
        writeCache({
            data: fallbackData,
            error: true,
            source,
            errorReason: 'network',
            lastSuccessAt: cache?.lastSuccessAt,
        });
        return fallbackData
            ? { rateLimits: fallbackData, error: 'network', stale: true }
            : { rateLimits: null, error: 'network' };
    }
    writeCache({ data: usage, error: false, source, lastSuccessAt: Date.now() });
    return { rateLimits: usage };
}
/**
 * Get usage data (with caching)
 *
 * Returns a UsageResult with:
 * - rateLimits: RateLimits on success, null on failure/no credentials
 * - error: categorized reason when API call fails (undefined on success or no credentials)
 *   - 'network': API call failed (timeout, HTTP error, parse error)
 *   - 'auth': credentials expired (never refreshed here — Claude Code does that; stale data served if recent)
 *   - 'no_credentials': no OAuth credentials available (expected for API key users)
 *   - 'rate_limited': API returned 429; stale data served if available, with exponential backoff
 *
 * `opts.budgetMs` caps the wait on the API (0/absent = API_TIMEOUT_MS only).
 * Past it the cached data, if any, is served and the cache is left untouched.
 */
export async function getUsage(opts) {
    const budgetMs = opts?.budgetMs > 0 ? opts.budgetMs : 0;
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const currentSource = 'anthropic';
    // Custom gateway guard: when ANTHROPIC_BASE_URL points to a third-party provider
    // that is not Anthropic, there is no usage endpoint to query. Querying Anthropic's
    // OAuth usage here would surface the local Claude subscription's limits, which do
    // not describe the active provider — so report no credentials and let the HUD
    // render nothing. Runs before any cache read so a stale cache cannot leak through.
    if (baseUrl != null && !isAnthropicHost(baseUrl)) {
        return { rateLimits: null, error: 'no_credentials' };
    }
    const pollIntervalMs = getUsagePollIntervalMs();
    // Migrate legacy single-file cache to provider-specific file (one-shot, best-effort)
    migrateLegacyCache(currentSource);
    const initialCache = readCache(currentSource);
    if (initialCache && isCacheValid(initialCache, pollIntervalMs) && initialCache.source === currentSource) {
        return getCachedUsageResult(initialCache);
    }
    try {
        return await withFileLock(lockPathFor(getCachePath(currentSource)), async () => {
            const cache = readCache(currentSource);
            if (cache && isCacheValid(cache, pollIntervalMs) && cache.source === currentSource) {
                return getCachedUsageResult(cache);
            }
            // Anthropic OAuth path (official Claude Code support)
            const creds = getCredentials();
            if (creds) {
                if (!validateCredentials(creds)) {
                    // Expired. Deliberately NOT refreshed (see the header):
                    // Claude Code refreshes and rewrites the store on its own,
                    // and the short 'auth' TTL re-reads it soon after. Until
                    // then serve the last good numbers, stale-marked, while
                    // they are recent enough to mean anything.
                    const fallbackData = hasUsableStaleData(cache) ? cache.data : null;
                    writeCache({
                        data: fallbackData,
                        error: true,
                        source: 'anthropic',
                        errorReason: 'auth',
                        lastSuccessAt: cache?.lastSuccessAt,
                    });
                    return fallbackData
                        ? { rateLimits: fallbackData, error: 'auth', stale: true }
                        : { rateLimits: null, error: 'auth' };
                }
                const accessToken = creds.accessToken;
                const subscriptionType = creds.subscriptionType;
                const rateLimitTier = creds.rateLimitTier;
                return fetchAndCacheUsage({
                    source: 'anthropic',
                    fetchFn: () => fetchUsageFromApi(accessToken, budgetMs),
                    parseFn: (data) => parseUsageResponse(data, {
                        subscriptionType,
                        rateLimitTier,
                    }),
                    cache,
                    pollIntervalMs,
                });
            }
            writeCache({ data: null, error: true, source: 'anthropic', errorReason: 'no_credentials' });
            return { rateLimits: null, error: 'no_credentials' };
        }, USAGE_CACHE_LOCK_OPTS);
    }
    catch (err) {
        // Lock acquisition failed — return stale cache without touching the cache file
        // to avoid racing with the lock holder writing fresh data. The same
        // MAX_STALE_DATA_MS cap and error reason apply as on any other stale serve,
        // so a lock that stays held cannot surface numbers of any age.
        if (err instanceof Error && err.message.startsWith('Failed to acquire file lock')) {
            if (hasUsableStaleData(initialCache)) {
                const reason = initialCache.rateLimited
                    ? 'rate_limited'
                    : initialCache.error ? initialCache.errorReason || 'network' : undefined;
                return reason
                    ? { rateLimits: initialCache.data, error: reason, stale: true }
                    : { rateLimits: initialCache.data, stale: true };
            }
            return { rateLimits: null, error: 'network' };
        }
        return { rateLimits: null, error: 'network' };
    }
}
