/*
 * Zancord Remote Plugin System
 * Copyright (c) 2026 Zan / zanverse.lol
 *
 * Remote Plugins settings tab UI.
 */

import "./styles.css";

import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab } from "@components/settings";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { React, TextInput, Toasts, useState } from "@webpack/common";

import {
    autoUpdatePlugins,
    fetchManifest,
    getAutoUpdate,
    getAvailableUpdates,
    getStore,
    hasUpdate,
    installPlugin,
    isRemotePlugin,
    setAutoUpdate,
    uninstallPlugin,
    updatePlugin,
} from "@api/RemotePlugins";
import { RemotePluginManifestEntry } from "@api/RemotePlugins/types";

function showToast(message: string, type: number = Toasts.Type.SUCCESS) {
    Toasts.show({
        message,
        type,
        id: Toasts.genId(),
        options: { position: Toasts.Position.BOTTOM },
    });
}

function RemotePluginCard({
    entry,
    installed,
    updateAvailable,
    onAction,
}: {
    entry: RemotePluginManifestEntry;
    installed: boolean;
    updateAvailable: boolean;
    onAction: () => void;
}) {
    const [loading, setLoading] = useState(false);

    const handleInstall = async () => {
        setLoading(true);
        try {
            const success = await installPlugin(entry);
            if (success) {
                showToast(`Installed ${entry.name} v${entry.version}`);
            } else {
                showToast(`Failed to install ${entry.name}`, Toasts.Type.FAILURE);
            }
        } catch (e) {
            showToast(`Error installing ${entry.name}: ${e}`, Toasts.Type.FAILURE);
        }
        setLoading(false);
        onAction();
    };

    const handleUpdate = async () => {
        setLoading(true);
        try {
            const success = await updatePlugin(entry);
            if (success) {
                showToast(`Updated ${entry.name} to v${entry.version}`);
            } else {
                showToast(`Failed to update ${entry.name}`, Toasts.Type.FAILURE);
            }
        } catch (e) {
            showToast(`Error updating ${entry.name}: ${e}`, Toasts.Type.FAILURE);
        }
        setLoading(false);
        onAction();
    };

    const handleUninstall = async () => {
        setLoading(true);
        try {
            const success = await uninstallPlugin(entry.name);
            if (success) {
                showToast(`Uninstalled ${entry.name}`);
            } else {
                showToast(`Failed to uninstall ${entry.name}`, Toasts.Type.FAILURE);
            }
        } catch (e) {
            showToast(`Error uninstalling ${entry.name}: ${e}`, Toasts.Type.FAILURE);
        }
        setLoading(false);
        onAction();
    };

    const store = getStore();
    const installedVersion = store.installed[entry.name]?.version;

    return (
        <div className="vc-remote-plugin-card">
            <div className="vc-remote-plugin-card-header">
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                    <h3 className="vc-remote-plugin-card-name">{entry.name}</h3>
                    <span className="vc-remote-plugin-card-version">
                        v{installed ? installedVersion : entry.version}
                    </span>
                </div>
                <span
                    className={classes(
                        "vc-remote-plugin-card-status",
                        installed ? (updateAvailable ? "update-available" : "installed") : "not-installed"
                    )}
                >
                    {installed ? (updateAvailable ? "Update Available" : "Installed") : ""}
                </span>
            </div>

            <p className="vc-remote-plugin-card-description">{entry.description}</p>

            <p className="vc-remote-plugin-card-authors">
                By {entry.authors.join(", ")}
            </p>

            {entry.tags && entry.tags.length > 0 && (
                <div className="vc-remote-plugin-card-tags">
                    {entry.tags.map(tag => (
                        <span key={tag} className="vc-remote-plugin-card-tag">{tag}</span>
                    ))}
                </div>
            )}

            {updateAvailable && entry.changelog && (
                <div className="vc-remote-plugin-changelog">
                    <strong>What's new:</strong> {entry.changelog}
                </div>
            )}

            <div className="vc-remote-plugin-card-footer">
                <div className="vc-remote-plugin-card-actions">
                    {!installed && (
                        <Button
                            variant="primary"
                            size="small"
                            disabled={loading}
                            onClick={handleInstall}
                        >
                            {loading ? "Installing..." : "Install"}
                        </Button>
                    )}
                    {installed && updateAvailable && (
                        <Button
                            variant="primary"
                            size="small"
                            disabled={loading}
                            onClick={handleUpdate}
                        >
                            {loading ? "Updating..." : `Update to v${entry.version}`}
                        </Button>
                    )}
                    {installed && (
                        <Button
                            variant="secondary"
                            size="small"
                            color="red"
                            disabled={loading}
                            onClick={handleUninstall}
                        >
                            {loading ? "Removing..." : "Uninstall"}
                        </Button>
                    )}
                </div>
                {entry.sourceUrl && (
                    <a
                        href={entry.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: "12px", color: "var(--text-link)" }}
                    >
                        Source
                    </a>
                )}
            </div>
        </div>
    );
}

export default function RemotePluginsTab() {
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [, forceUpdate] = useState({});
    const refresh = () => forceUpdate({});

    const store = getStore();
    const manifest = store.manifest;
    const installedCount = Object.keys(store.installed).length;
    const availableUpdates = getAvailableUpdates();

    const handleRefresh = async () => {
        setLoading(true);
        try {
            const result = await fetchManifest(true);
            if (result) {
                showToast(`Loaded ${result.plugins.length} remote plugins`);
            } else {
                showToast("Failed to fetch plugin manifest", Toasts.Type.FAILURE);
            }
        } catch (e) {
            showToast(`Error: ${e}`, Toasts.Type.FAILURE);
        }
        setLoading(false);
        refresh();
    };

    const handleUpdateAll = async () => {
        setLoading(true);
        let updated = 0;
        let failed = 0;

        for (const entry of availableUpdates) {
            const success = await updatePlugin(entry);
            if (success) updated++;
            else failed++;
        }

        if (updated > 0) showToast(`Updated ${updated} plugin(s)`);
        if (failed > 0) showToast(`Failed to update ${failed} plugin(s)`, Toasts.Type.FAILURE);

        setLoading(false);
        refresh();
    };

    const lowerSearch = search.toLowerCase();
    const filteredPlugins = manifest?.plugins.filter(entry =>
        entry.name.toLowerCase().includes(lowerSearch) ||
        entry.description.toLowerCase().includes(lowerSearch) ||
        entry.tags?.some(t => t.toLowerCase().includes(lowerSearch)) ||
        entry.authors.some(a => a.toLowerCase().includes(lowerSearch))
    ) ?? [];

    return (
        <SettingsTab>
            <div className="vc-remote-plugins-info-card">
                <p>
                    Remote plugins are downloaded and loaded at runtime from the Zancord plugin registry.
                    They cannot modify Discord's webpack modules (no patches), but can use all other plugin APIs.
                    Installed plugins are cached locally for offline use.
                </p>
            </div>

            <div className="vc-remote-plugins-auto-update">
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                        type="checkbox"
                        checked={getAutoUpdate()}
                        onChange={e => {
                            setAutoUpdate(e.currentTarget.checked);
                            refresh();
                        }}
                        style={{ width: "18px", height: "18px", accentColor: "var(--brand-experiment)" }}
                    />
                    <span style={{ fontSize: "14px", color: "var(--header-secondary)" }}>
                        Auto-update installed plugins on startup
                    </span>
                </label>
            </div>

            <div className="vc-remote-plugins-stats">
                <div className="vc-remote-plugins-stat">
                    <div className="vc-remote-plugins-stat-value">{manifest?.plugins.length ?? 0}</div>
                    <div className="vc-remote-plugins-stat-label">Available</div>
                </div>
                <div className="vc-remote-plugins-stat">
                    <div className="vc-remote-plugins-stat-value">{installedCount}</div>
                    <div className="vc-remote-plugins-stat-label">Installed</div>
                </div>
                <div className="vc-remote-plugins-stat">
                    <div className="vc-remote-plugins-stat-value">{availableUpdates.length}</div>
                    <div className="vc-remote-plugins-stat-label">Updates</div>
                </div>
            </div>

            <div className="vc-remote-plugins-header">
                <HeadingTertiary>Remote Plugins</HeadingTertiary>
                <div className="vc-remote-plugins-header-actions">
                    {availableUpdates.length > 0 && (
                        <Button
                            variant="primary"
                            size="small"
                            disabled={loading}
                            onClick={handleUpdateAll}
                        >
                            {loading ? "Updating..." : `Update All (${availableUpdates.length})`}
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        size="small"
                        disabled={loading}
                        onClick={handleRefresh}
                    >
                        {loading ? "Refreshing..." : "Refresh"}
                    </Button>
                </div>
            </div>

            <TextInput
                autoFocus
                value={search}
                placeholder="Search remote plugins..."
                onChange={setSearch}
                className={classes(Margins.bottom16)}
            />

            {!manifest && !loading && (
                <div className="vc-remote-plugins-empty">
                    <p>No plugin manifest loaded yet.</p>
                    <p>Click "Refresh" to fetch available remote plugins.</p>
                </div>
            )}

            {loading && filteredPlugins.length === 0 && (
                <div className="vc-remote-plugins-loading">
                    <p>Loading remote plugins...</p>
                </div>
            )}

            {filteredPlugins.length > 0 && (
                <div className="vc-remote-plugins-grid">
                    {filteredPlugins.map(entry => {
                        const installed = isRemotePlugin(entry.name);
                        const update = hasUpdate(entry.name);

                        return (
                            <RemotePluginCard
                                key={entry.name}
                                entry={entry}
                                installed={installed}
                                updateAvailable={!!update}
                                onAction={refresh}
                            />
                        );
                    })}
                </div>
            )}

            {manifest && filteredPlugins.length === 0 && search && (
                <Paragraph className={Margins.top16}>
                    No remote plugins match the search criteria.
                </Paragraph>
            )}
        </SettingsTab>
    );
}
