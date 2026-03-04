/*
 * Zancord Remote Plugin System
 * Copyright (c) 2026 Zan / zanverse.lol
 *
 * Remote plugin types and manifest schema.
 */

export interface RemotePluginManifestEntry {
    /** Unique plugin identifier (must match the name in definePlugin()) */
    name: string;
    /** Human-readable description */
    description: string;
    /** Semver version string */
    version: string;
    /** Author name(s) */
    authors: string[];
    /** URL to download the plugin JS bundle */
    downloadUrl: string;
    /** SHA-256 hash of the bundle for integrity verification */
    hash: string;
    /** Optional URL to plugin CSS */
    cssUrl?: string;
    /** SHA-256 hash of the CSS file */
    cssHash?: string;
    /** Minimum Zancord version required (semver) */
    minZancordVersion?: string;
    /** Tags for search/filtering */
    tags?: string[];
    /** Plugin dependencies (names of other plugins that must be loaded first) */
    dependencies?: string[];
    /** Whether this plugin has settings UI */
    hasSettings?: boolean;
    /** Changelog / what's new for this version */
    changelog?: string;
    /** Source code URL (for transparency) */
    sourceUrl?: string;
}

export interface RemotePluginManifest {
    /** Manifest schema version */
    schemaVersion: number;
    /** ISO timestamp of last manifest update */
    updatedAt: string;
    /** Available plugins */
    plugins: RemotePluginManifestEntry[];
}

export interface InstalledRemotePlugin {
    /** Plugin name */
    name: string;
    /** Installed version */
    version: string;
    /** SHA-256 hash of installed bundle */
    hash: string;
    /** The JS bundle source code */
    code: string;
    /** Optional CSS source */
    css?: string;
    /** SHA-256 hash of installed CSS */
    cssHash?: string;
    /** Whether the user has enabled this plugin */
    enabled: boolean;
    /** Timestamp of installation */
    installedAt: number;
    /** Timestamp of last update */
    updatedAt: number;
}

export interface RemotePluginStore {
    /** Cached manifest */
    manifest: RemotePluginManifest | null;
    /** Last time manifest was fetched (unix timestamp ms) */
    lastManifestFetch: number;
    /** Map of installed plugins keyed by name */
    installed: Record<string, InstalledRemotePlugin>;
    /** Whether to auto-update installed plugins on boot */
    autoUpdate: boolean;
}

export const REMOTE_PLUGIN_STORE_KEY = "Zancord_remotePlugins";
export const DEFAULT_MANIFEST_URL = "https://plugins.zanverse.lol/manifest.json";
export const MANIFEST_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
