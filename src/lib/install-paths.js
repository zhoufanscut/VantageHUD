/**
 * HUD install-root + user-config path resolution.
 *
 * The HUD's runtime files (`cache/`) and its user config (`config.json`) both
 * live under the install root, derived from this module's location so a
 * relocated install carries them along — the same root `statusline.sh` resolves
 * from `$SCRIPT_DIR`.
 *
 * Kept dependency-free (only `path` + `url`) on purpose: `themes.js` imports
 * `getHudConfigFile` at module-load to pick the palette, so this must not pull
 * in heavier modules (or risk an import cycle) the way `state.js` would.
 */
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve the HUD install root. This module lives at `<install>/src/lib/`, so
 * the root is two directories up.
 */
export function getHudInstallRoot() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    return resolve(moduleDir, '..', '..');
}

/**
 * Resolve the HUD user-config file: `<install>/config.json` by default,
 * overridable with the `HUD_CONFIG` env var (an absolute path to a JSON file).
 *
 * The file is optional — when it is absent (or unreadable) the HUD runs on the
 * defaults in `src/hud/types.js`. Copy `config.json.example` to `config.json`
 * to start customizing.
 */
export function getHudConfigFile() {
    const override = process.env.HUD_CONFIG?.trim();
    if (override) {
        return override;
    }
    return join(getHudInstallRoot(), 'config.json');
}
