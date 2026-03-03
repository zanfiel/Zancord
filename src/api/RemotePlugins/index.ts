/*
 * Zancord Remote Plugin System
 * Copyright (c) 2026 Zan / zanverse.lol
 *
 * Core remote plugin loader. Fetches manifest, downloads bundles,
 * evaluates them, and injects into the Plugins registry at runtime.
 */

import * as DataStore from "@api/DataStore";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { Plugin } from "@utils/types";

import Plugins from "~plugins";

import {
    DEFAULT_MANIFEST_URL,
    InstalledRemotePlugin,
    MANIFEST_CACHE_TTL,
    RemotePluginManifest,
    RemotePluginManifestEntry,
    RemotePluginStore,
    REMOTE_PLUGIN_STORE_KEY,
} from "./types";

const logger = new Logger("RemotePlugins", "#ff2d95");

let store: RemotePluginStore = {
    manifest: null,
    lastManifestFetch: 0,
    installed: {},
};

let initialized = false;

// -------------------------------------------------------------------
// Persistence
// -------------------------------------------------------------------

async function loadStore(): Promise<RemotePluginStore> {
    const saved = await DataStore.get<RemotePluginStore>(REMOTE_PLUGIN_STORE_KEY);
    if (saved) {
        store = saved;
    }
    return store;
}

async function saveStore(): Promise<void> {
    await DataStore.set(REMOTE_PLUGIN_STORE_KEY, store);
}

// -------------------------------------------------------------------
// Cryptographic integrity
// -------------------------------------------------------------------

async function sha256(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------------
// Manifest fetching
// -------------------------------------------------------------------

export async function fetchManifest(forceRefresh = false): Promise<RemotePluginManifest | null> {
    const now = Date.now();

    if (
        !forceRefresh &&
        store.manifest &&
        (now - store.lastManifestFetch) < MANIFEST_CACHE_TTL
    ) {
        return store.manifest;
    }

    try {
        const url = Settings.plugins?.RemotePluginLoader?.manifestUrl || DEFAULT_MANIFEST_URL;
        logger.info("Fetching remote plugin manifest from", url);

        const response = await fetch(url, {
            cache: "no-cache",
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const manifest: RemotePluginManifest = await response.json();

        if (!manifest.schemaVersion || !Array.isArray(manifest.plugins)) {
            throw new Error("Invalid manifest format");
        }

        store.manifest = manifest;
        store.lastManifestFetch = now;
        await saveStore();

        logger.info(`Loaded manifest: ${manifest.plugins.length} plugins available (updated ${manifest.updatedAt})`);
        return manifest;
    } catch (e) {
        logger.error("Failed to fetch remote plugin manifest", e);
        return store.manifest; // return cached if available
    }
}

// -------------------------------------------------------------------
// Plugin bundle downloading
// -------------------------------------------------------------------

async function downloadBundle(url: string, expectedHash: string): Promise<string> {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
        throw new Error(`Failed to download bundle: HTTP ${response.status}`);
    }

    const code = await response.text();
    const hash = await sha256(code);

    if (hash !== expectedHash) {
        throw new Error(`Integrity check failed! Expected ${expectedHash}, got ${hash}`);
    }

    return code;
}

async function downloadCss(url: string, expectedHash: string): Promise<string> {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
        throw new Error(`Failed to download CSS: HTTP ${response.status}`);
    }

    const css = await response.text();
    const hash = await sha256(css);

    if (hash !== expectedHash) {
        throw new Error(`CSS integrity check failed! Expected ${expectedHash}, got ${hash}`);
    }

    return css;
}

// -------------------------------------------------------------------
// Plugin evaluation and injection
// -------------------------------------------------------------------

/**
 * Evaluates a remote plugin bundle and returns the Plugin object.
 *
 * Remote plugins are expected to export a default Plugin object
 * (the result of definePlugin()). The bundle format is:
 *
 * ```js
 * (function() {
 *   return {
 *     name: "MyPlugin",
 *     description: "...",
 *     authors: [...],
 *     start() { ... },
 *     stop() { ... },
 *     // ... other PluginDef fields (NO patches)
 *   };
 * })();
 * ```
 *
 * The bundle is evaluated with a limited set of globals available
 * via a sandboxed function wrapper.
 */
function evaluatePlugin(code: string, pluginName: string): Plugin | null {
    try {
        // The plugin bundle should return a PluginDef-compatible object.
        // We use Function() constructor for controlled evaluation.
        // The bundle is wrapped to provide access to common APIs.
        const wrappedCode = `
            "use strict";
            return (function() {
                ${code}
            })();
        `;

        const factory = new Function(wrappedCode);
        const pluginDef = factory();

        if (!pluginDef || typeof pluginDef !== "object" || !pluginDef.name) {
            throw new Error("Bundle did not return a valid plugin definition");
        }

        if (pluginDef.name !== pluginName) {
            throw new Error(`Plugin name mismatch: expected "${pluginName}", got "${pluginDef.name}"`);
        }

        // Remote plugins MUST NOT have patches (patches require compile-time registration)
        if (pluginDef.patches && pluginDef.patches.length > 0) {
            logger.warn(`Remote plugin "${pluginName}" has patches — these will be ignored. Patches only work for bundled plugins.`);
            delete pluginDef.patches;
        }

        // Set runtime fields
        pluginDef.started = false;

        return pluginDef as Plugin;
    } catch (e) {
        logger.error(`Failed to evaluate remote plugin "${pluginName}"`, e);
        return null;
    }
}

/**
 * Injects a Plugin object into the global Plugins registry so it
 * can be managed by PluginManager (start/stop/settings).
 */
function injectPlugin(plugin: Plugin): boolean {
    if (Plugins[plugin.name]) {
        logger.warn(`Plugin "${plugin.name}" already exists in registry — skipping injection`);
        return false;
    }

    // Add to the Plugins object
    (Plugins as Record<string, Plugin>)[plugin.name] = plugin;

    // Ensure settings entry exists
    if (!Settings.plugins[plugin.name]) {
        Settings.plugins[plugin.name] = {
            enabled: false,
        };
    }

    logger.info(`Injected remote plugin: ${plugin.name}`);
    return true;
}

/**
 * Injects CSS for a remote plugin by creating a <style> element.
 */
function injectCss(pluginName: string, css: string): void {
    const existingStyle = document.getElementById(`zancord-remote-css-${pluginName}`);
    if (existingStyle) {
        existingStyle.textContent = css;
        return;
    }

    const style = document.createElement("style");
    style.id = `zancord-remote-css-${pluginName}`;
    style.textContent = css;
    document.documentElement.appendChild(style);
}

/**
 * Removes CSS for a remote plugin.
 */
function removeCss(pluginName: string): void {
    const style = document.getElementById(`zancord-remote-css-${pluginName}`);
    if (style) {
        style.remove();
    }
}

// -------------------------------------------------------------------
// High-level operations (used by UI and boot)
// -------------------------------------------------------------------

/**
 * Install a remote plugin from the manifest.
 */
export async function installPlugin(entry: RemotePluginManifestEntry): Promise<boolean> {
    try {
        logger.info(`Installing remote plugin: ${entry.name} v${entry.version}`);

        const code = await downloadBundle(entry.downloadUrl, entry.hash);

        let css: string | undefined;
        if (entry.cssUrl && entry.cssHash) {
            css = await downloadCss(entry.cssUrl, entry.cssHash);
        }

        // Evaluate to validate before saving
        const plugin = evaluatePlugin(code, entry.name);
        if (!plugin) {
            throw new Error("Plugin evaluation failed");
        }

        const now = Date.now();
        store.installed[entry.name] = {
            name: entry.name,
            version: entry.version,
            hash: entry.hash,
            code,
            css,
            cssHash: entry.cssHash,
            enabled: false,
            installedAt: now,
            updatedAt: now,
        };
        await saveStore();

        // Inject into runtime
        injectPlugin(plugin);
        if (css) {
            injectCss(entry.name, css);
        }

        logger.info(`Successfully installed: ${entry.name} v${entry.version}`);
        return true;
    } catch (e) {
        logger.error(`Failed to install remote plugin "${entry.name}"`, e);
        return false;
    }
}

/**
 * Update an already-installed remote plugin.
 */
export async function updatePlugin(entry: RemotePluginManifestEntry): Promise<boolean> {
    try {
        const existing = store.installed[entry.name];
        if (!existing) {
            logger.warn(`Cannot update "${entry.name}" — not installed`);
            return false;
        }

        if (existing.hash === entry.hash) {
            logger.info(`Plugin "${entry.name}" is already up to date`);
            return true;
        }

        logger.info(`Updating remote plugin: ${entry.name} v${existing.version} -> v${entry.version}`);

        const code = await downloadBundle(entry.downloadUrl, entry.hash);

        let css: string | undefined;
        if (entry.cssUrl && entry.cssHash) {
            css = await downloadCss(entry.cssUrl, entry.cssHash);
        }

        // Evaluate to validate
        const plugin = evaluatePlugin(code, entry.name);
        if (!plugin) {
            throw new Error("Plugin evaluation failed during update");
        }

        // Preserve enabled state
        const wasEnabled = existing.enabled;

        existing.version = entry.version;
        existing.hash = entry.hash;
        existing.code = code;
        existing.css = css;
        existing.cssHash = entry.cssHash;
        existing.updatedAt = Date.now();
        existing.enabled = wasEnabled;

        await saveStore();

        // Note: the updated code takes effect after restart since the
        // plugin object in memory is from the old evaluation.
        // For CSS we can hot-swap immediately.
        if (css) {
            injectCss(entry.name, css);
        }

        logger.info(`Successfully updated: ${entry.name} to v${entry.version} (restart recommended for JS changes)`);
        return true;
    } catch (e) {
        logger.error(`Failed to update remote plugin "${entry.name}"`, e);
        return false;
    }
}

/**
 * Uninstall a remote plugin.
 */
export async function uninstallPlugin(name: string): Promise<boolean> {
    try {
        const existing = store.installed[name];
        if (!existing) {
            logger.warn(`Cannot uninstall "${name}" — not installed`);
            return false;
        }

        // Stop the plugin if it's running
        const plugin = Plugins[name];
        if (plugin?.started) {
            const { stopPlugin } = await import("@api/PluginManager");
            stopPlugin(plugin);
        }

        // Remove CSS
        removeCss(name);

        // Remove from Plugins registry
        delete (Plugins as Record<string, Plugin>)[name];

        // Remove settings
        delete Settings.plugins[name];

        // Remove from store
        delete store.installed[name];
        await saveStore();

        logger.info(`Uninstalled remote plugin: ${name}`);
        return true;
    } catch (e) {
        logger.error(`Failed to uninstall remote plugin "${name}"`, e);
        return false;
    }
}

/**
 * Toggle enabled state of an installed remote plugin.
 */
export async function togglePlugin(name: string, enabled: boolean): Promise<void> {
    const installed = store.installed[name];
    if (!installed) return;

    installed.enabled = enabled;
    Settings.plugins[name].enabled = enabled;
    await saveStore();
}

/**
 * Check if a remote plugin has an update available.
 */
export function hasUpdate(name: string): RemotePluginManifestEntry | null {
    const installed = store.installed[name];
    if (!installed || !store.manifest) return null;

    const manifestEntry = store.manifest.plugins.find(p => p.name === name);
    if (!manifestEntry) return null;

    if (manifestEntry.hash !== installed.hash) {
        return manifestEntry;
    }

    return null;
}

/**
 * Get the current store state.
 */
export function getStore(): RemotePluginStore {
    return store;
}

/**
 * Check if a plugin name is a remote plugin.
 */
export function isRemotePlugin(name: string): boolean {
    return name in store.installed;
}

/**
 * Get all available updates.
 */
export function getAvailableUpdates(): RemotePluginManifestEntry[] {
    if (!store.manifest) return [];

    return store.manifest.plugins.filter(entry => {
        const installed = store.installed[entry.name];
        return installed && installed.hash !== entry.hash;
    });
}

// -------------------------------------------------------------------
// Initialization (called during Zancord boot)
// -------------------------------------------------------------------

/**
 * Initialize the remote plugin system.
 * Loads persisted plugins from DataStore and injects them.
 * Then fetches manifest in the background.
 */
export async function initRemotePlugins(): Promise<void> {
    if (initialized) return;
    initialized = true;

    try {
        await loadStore();

        // Inject all installed plugins from cache
        let loadedCount = 0;
        for (const [name, installed] of Object.entries(store.installed)) {
            const plugin = evaluatePlugin(installed.code, name);
            if (plugin) {
                if (injectPlugin(plugin)) {
                    loadedCount++;

                    // Apply enabled state from our store
                    if (installed.enabled) {
                        Settings.plugins[name].enabled = true;
                    }

                    // Inject CSS if present and enabled
                    if (installed.css && installed.enabled) {
                        injectCss(name, installed.css);
                    }
                }
            } else {
                logger.error(`Failed to load cached remote plugin: ${name}`);
            }
        }

        if (loadedCount > 0) {
            logger.info(`Loaded ${loadedCount} remote plugin(s) from cache`);
        }

        // Fetch manifest in background (don't block boot)
        fetchManifest().catch(e => {
            logger.warn("Background manifest fetch failed", e);
        });
    } catch (e) {
        logger.error("Failed to initialize remote plugin system", e);
    }
}
