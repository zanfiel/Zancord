/*
 * Zancord, a Discord client mod
 * Copyright (c) 2026 Zan and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./zancordTheme.css";

import { managedStyleRootNode } from "@api/Styles";
import { definePluginSettings } from "@api/Settings";
import { ZancordDevs } from "@utils/constants";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.ZancordTheme as PluginNative<typeof import("./native")>;

const THEME_STYLE_ID = "zancord-synthwave-vars";
const OVERRIDE_STYLE_ID = "zancord-synthwave-overrides";
const EXTRA_STYLE_ID = "zancord-synthwave-extra";
const BG_STYLE_ID = "zancord-synthwave-bg";

const styleCache: Record<string, HTMLStyleElement | null> = {};

// -- Synthwave Cyberpunk Palette --
const palettes = {
    neonNights: {
        label: "Neon Nights",
        bgDeep: "#08020e",
        bgPrimary: "#0d0221",
        bgSecondary: "#120329",
        bgTertiary: "#0a0118",
        bgFloating: "#150435",
        accent: "#ff2d95",       // hot pink
        accentSecondary: "#00f0ff", // cyan
        accentTertiary: "#b429f9",  // electric purple
        text: "#e0d6ff",
        textMuted: "#8a7bab",
        textLink: "#00f0ff",
        border: "#2a1450",
        glow: "#ff2d95",
        glowSecondary: "#00f0ff",
    },
    voidRunner: {
        label: "Void Runner",
        bgDeep: "#000810",
        bgPrimary: "#001020",
        bgSecondary: "#001830",
        bgTertiary: "#000610",
        bgFloating: "#002040",
        accent: "#00ff88",
        accentSecondary: "#00ccff",
        accentTertiary: "#7b2ff7",
        text: "#d0ffe8",
        textMuted: "#5a9e7a",
        textLink: "#00ff88",
        border: "#003322",
        glow: "#00ff88",
        glowSecondary: "#00ccff",
    },
    sunsetGrid: {
        label: "Sunset Grid",
        bgDeep: "#0e0005",
        bgPrimary: "#1a0a12",
        bgSecondary: "#22101a",
        bgTertiary: "#120008",
        bgFloating: "#2a1420",
        accent: "#ff6b35",
        accentSecondary: "#f72585",
        accentTertiary: "#ffd000",
        text: "#ffe0d0",
        textMuted: "#a07060",
        textLink: "#ff6b35",
        border: "#3a1520",
        glow: "#ff6b35",
        glowSecondary: "#f72585",
    },
    deepOcean: {
        label: "Deep Ocean (Default)",
        bgDeep: "#020a12",
        bgPrimary: "#06111d",
        bgSecondary: "#0a1928",
        bgTertiary: "#040d16",
        bgFloating: "#0e2035",
        accent: "#00d4ff",       // bright cyan
        accentSecondary: "#0088cc", // deep blue
        accentTertiary: "#4dc9f6",  // light cyan
        text: "#d0e8ff",
        textMuted: "#5a8aaa",
        textLink: "#00d4ff",
        border: "#0d2a42",
        glow: "#00d4ff",
        glowSecondary: "#0088cc",
    },
};

type PaletteKey = keyof typeof palettes;

function getPalette(key: string) {
    return palettes[key as PaletteKey] ?? palettes.deepOcean;
}

function getOrCreateStyle(id: string) {
    if (!styleCache[id]) {
        styleCache[id] = createAndAppendStyle(id, managedStyleRootNode);
    }
    return styleCache[id]!;
}

function setStyle(id: string, css: string) {
    const el = getOrCreateStyle(id);
    el.textContent = css;
}

function hexToHSL(hex: string) {
    hex = hex.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        l: Math.round(l * 100),
    };
}

function hexToRGB(hex: string) {
    hex = hex.replace("#", "");
    return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
    };
}

function hexToRGBA(hex: string, alpha: number) {
    const { r, g, b } = hexToRGB(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}



async function getDiscordStyles(): Promise<string> {
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
    const texts = await Promise.all(
        Array.from(links, async node => node.href ? fetch(node.href).then(r => r.text()) : null)
    );
    return texts.filter(Boolean).join("\n");
}

const NEUTRAL_HSL_REGEX = /(--neutral-\d{1,3}?-hsl):.+?([\d.]+?)%;/g;

function applyTheme(paletteKey?: string) {
    const palette = paletteKey ?? settings.store.palette ?? "deepOcean";
    const p = getPalette(palette);
    const bg = hexToHSL(p.bgPrimary);

    const bgImage = settings.store.backgroundImage ?? "";
    const panelAlpha = (settings.store.panelOpacity ?? 75) / 100;
    const hasBgImage = bgImage.trim().length > 0;

    // If bg image is set, use transparent backgrounds; otherwise solid
    const bgDeep = hasBgImage ? hexToRGBA(p.bgDeep, panelAlpha * 0.9) : p.bgDeep;
    const bgPrimary = hasBgImage ? hexToRGBA(p.bgPrimary, panelAlpha) : p.bgPrimary;
    const bgSecondary = hasBgImage ? hexToRGBA(p.bgSecondary, panelAlpha) : p.bgSecondary;
    const bgTertiary = hasBgImage ? hexToRGBA(p.bgTertiary, panelAlpha * 0.9) : p.bgTertiary;
    const bgFloating = hasBgImage ? hexToRGBA(p.bgFloating, Math.min(panelAlpha + 0.1, 0.95)) : p.bgFloating;

    // Set base CSS variables
    setStyle(THEME_STYLE_ID, `:root {
        --zc-bg-deep: ${bgDeep};
        --zc-bg-primary: ${bgPrimary};
        --zc-bg-secondary: ${bgSecondary};
        --zc-bg-tertiary: ${bgTertiary};
        --zc-bg-floating: ${bgFloating};
        --zc-accent: ${p.accent};
        --zc-accent-secondary: ${p.accentSecondary};
        --zc-accent-tertiary: ${p.accentTertiary};
        --zc-text: ${p.text};
        --zc-text-muted: ${p.textMuted};
        --zc-text-link: ${p.textLink};
        --zc-border: ${p.border};
        --zc-glow: ${p.glow};
        --zc-glow-secondary: ${p.glowSecondary};

        --theme-h: ${bg.h};
        --theme-s: ${bg.s}%;
        --theme-l: ${bg.l}%;
    }`);

    // Apply Discord neutral color overrides
    getDiscordStyles().then(styles => {
        const lightness: Record<string, number> = {};
        for (const [, name, l] of styles.matchAll(NEUTRAL_HSL_REGEX)) {
            lightness[name] = parseFloat(l);
        }

        const darkBase = lightness["--neutral-69-hsl"];
        if (darkBase == null) return;

        const overrides = Object.entries(lightness).map(([name, l]) => {
            const offset = l - darkBase;
            const sign = offset >= 0 ? "+" : "-";
            return `${name}: var(--theme-h) var(--theme-s) calc(var(--theme-l) ${sign} ${Math.abs(offset).toFixed(2)}%);`;
        }).join("\n    ");

        setStyle(OVERRIDE_STYLE_ID, `.theme-dark {
    ${overrides}
}`);
    });

    // Apply extra synthwave overrides (accent colors, brand overrides, etc.)
    setStyle(EXTRA_STYLE_ID, `
        /* -- Zancord Synthwave Overrides -- */
        .theme-dark {
            --brand-500: ${p.accent};
            --brand-560: ${p.accent};
            --brand-600: ${p.accent};
            --text-brand: ${p.accent};

            --header-primary: ${p.text};
            --header-secondary: ${p.textMuted};
            --text-normal: ${p.text};
            --text-muted: ${p.textMuted};
            --text-link: ${p.textLink};
            --interactive-normal: ${p.text};
            --interactive-hover: ${p.accentSecondary};
            --interactive-active: ${p.accent};
            --interactive-muted: ${p.textMuted};

            --background-primary: ${bgPrimary};
            --background-secondary: ${bgSecondary};
            --background-secondary-alt: ${bgTertiary};
            --background-tertiary: ${bgTertiary};
            --background-accent: ${bgFloating};
            --background-floating: ${bgFloating};
            --background-modifier-hover: ${p.accent}12;
            --background-modifier-active: ${p.accent}20;
            --background-modifier-selected: ${p.accent}18;
            --background-modifier-accent: ${p.border};

            --channeltextarea-background: ${bgTertiary};
            --input-background: ${bgTertiary};

            --scrollbar-thin-thumb: ${p.accent}44;
            --scrollbar-thin-track: transparent;
            --scrollbar-auto-thumb: ${p.accent}44;
            --scrollbar-auto-track: ${hasBgImage ? "transparent" : p.bgDeep};

            --focus-primary: ${p.accent};
            --control-brand-foreground: ${p.accent};
            --control-brand-foreground-new: ${p.accent};

            --mention-foreground: ${p.accent};
            --mention-background: ${p.accent}18;

            --info-positive-foreground: ${p.accentSecondary};
            --status-positive: ${p.accentSecondary};
        }
    `);

    // Apply background image
    applyBackgroundImage(bgImage, p, panelAlpha);
}

/** Resolve an image path to a usable URL via native IPC */
async function resolveImageUrl(imagePath: string): Promise<string> {
    if (!imagePath.trim()) return "";

    const trimmed = imagePath.trim();

    // HTTPS/HTTP URLs can be used directly
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // Local file path — read via IPC (main process has Node.js access)
    try {
        const dataUri = await Native.readImageFile(trimmed);
        if (dataUri) {
            console.log("[ZancordTheme] Loaded bg image via native IPC (" + dataUri.length + " chars)");
            return dataUri;
        }
        console.error("[ZancordTheme] Native readImageFile returned null for:", trimmed);
    } catch (e) {
        console.error("[ZancordTheme] Native IPC readImageFile failed:", e);
    }

    return "";
}

/** Apply the resolved image URL via a managed CSS rule on html */
function setHtmlBackground(imageUrl: string | null) {
    const id = "zancord-bg-wallpaper";
    if (!imageUrl) {
        styleCache[id]?.remove();
        styleCache[id] = null;
        return;
    }
    setStyle(id, `html { background: url("${imageUrl}") center/cover no-repeat fixed !important; }`);
    console.log("[ZancordTheme] Set html background via CSS:", imageUrl.slice(0, 80));
}

function applyBackgroundImage(imagePath: string, p: typeof palettes.neonNights, panelAlpha: number) {
    if (!imagePath.trim()) {
        // No background image — clear everything
        setHtmlBackground(null);
        if (styleCache[BG_STYLE_ID]) {
            styleCache[BG_STYLE_ID]!.textContent = "";
        }
        return;
    }

    // Shorthand for rgba with palette colors at various opacities
    const deep = (a: number) => hexToRGBA(p.bgDeep, a);
    const pri = (a: number) => hexToRGBA(p.bgPrimary, a);
    const sec = (a: number) => hexToRGBA(p.bgSecondary, a);
    const ter = (a: number) => hexToRGBA(p.bgTertiary, a);
    const flo = (a: number) => hexToRGBA(p.bgFloating, a);

    // STEP 1: Apply transparency CSS immediately (synchronous)
    setStyle(BG_STYLE_ID, `
        /* -- Zancord Background Transparency -- */

        /* === Keep body transparent so html bg shows through === */
        body {
            background: transparent !important;
            background-color: transparent !important;
        }

        /* === Override Discord's bg-overlay variables (newer Discord builds) === */
        .theme-dark, .theme-light, :root {
            --bg-overlay-1: transparent !important;
            --bg-overlay-2: transparent !important;
            --bg-overlay-3: transparent !important;
            --bg-overlay-chat: transparent !important;
            --bg-overlay-home: transparent !important;
            --bg-overlay-home-card: transparent !important;
            --home-background: transparent !important;
            --bg-base-primary: transparent !important;
            --bg-base-secondary: transparent !important;
            --bg-base-tertiary: transparent !important;
            --bg-surface-overlay: transparent !important;
        }

        /* === Nuclear transparency on ALL intermediate wrappers === */
        #app-mount,
        [class*="appAsidePanelWrapper_"],
        [class*="notAppAsidePanel_"],
        [class*="app_"]:not(body):not(html),
        [class*="layers_"],
        [class*="layer_"],
        [class*="baseLayer_"],
        [class*="container_"][class*="themed_"],
        [class*="bg_"],
        [class*="base_"]:not([class*="baseLayer_"]),
        [class*="content_"]:not([class*="chatContent_"]):not([class*="contentRegion_"]) {
            background: transparent !important;
            background-color: transparent !important;
        }

        /* === Chat / message area transparent === */
        [class*="chat_"]:not([class*="chatContent_"]),
        [class*="messagesWrapper_"],
        [class*="scroller_"][class*="auto_"],
        [class*="scrollerContent_"],
        [class*="channelTextArea_"],
        [class*="form_"] {
            background: transparent !important;
            background-color: transparent !important;
        }

        /* Header / title bar / toolbar area */
        [class*="title_"][class*="container_"],
        [class*="titleBar_"],
        [class*="toolbar_"],
        section[class*="title_"] {
            background: transparent !important;
            background-color: transparent !important;
        }

        /* DM / Friends list containers */
        [class*="peopleColumn_"],
        [class*="nowPlayingColumn_"],
        [class*="peopleList_"] {
            background: transparent !important;
            background-color: transparent !important;
        }

        /* === Semi-transparent panels (the actual visible surfaces) === */

        /* Server list / guild sidebar */
        [class*="guilds_"],
        nav[class*="guilds_"] {
            background: ${deep(panelAlpha * 0.7)} !important;
            background-color: ${deep(panelAlpha * 0.7)} !important;
        }

        /* Channel sidebar */
        [class*="sidebar_"][class*="container_"],
        nav[class*="sidebar_"] {
            background: ${sec(panelAlpha * 0.8)} !important;
            background-color: ${sec(panelAlpha * 0.8)} !important;
        }

        /* User voice/status panels at bottom of sidebar */
        [class*="panels_"] {
            background: ${ter(panelAlpha * 0.85)} !important;
            background-color: ${ter(panelAlpha * 0.85)} !important;
        }
        [class*="panels_"] > [class*="container_"] {
            background: ${ter(panelAlpha * 0.9)} !important;
            background-color: ${ter(panelAlpha * 0.9)} !important;
        }

        /* Chat content area */
        [class*="chatContent_"] {
            background: ${pri(panelAlpha * 0.55)} !important;
            background-color: ${pri(panelAlpha * 0.55)} !important;
        }

        /* Member list */
        [class*="membersWrap_"],
        [class*="membersWrap_"] [class*="members_"] {
            background: ${sec(panelAlpha * 0.75)} !important;
            background-color: ${sec(panelAlpha * 0.75)} !important;
        }

        /* Search results, threads panel */
        [class*="searchResultsWrap_"],
        [class*="threadSidebar_"] {
            background: ${sec(panelAlpha * 0.9)} !important;
            background-color: ${sec(panelAlpha * 0.9)} !important;
        }

        /* === Settings / overlays (more opaque for readability) === */
        [class*="contentRegion_"],
        [class*="sidebarRegion_"] {
            background: ${pri(Math.min(panelAlpha + 0.1, 0.95))} !important;
            background-color: ${pri(Math.min(panelAlpha + 0.1, 0.95))} !important;
        }

        /* Embeds */
        [class*="embedFull_"] {
            background: ${ter(Math.min(panelAlpha + 0.15, 0.95))} !important;
            background-color: ${ter(Math.min(panelAlpha + 0.15, 0.95))} !important;
        }

        /* Code blocks */
        [class*="markup_"] pre,
        [class*="codeBlock_"],
        code.inline {
            background: ${deep(Math.min(panelAlpha + 0.1, 0.95))} !important;
            background-color: ${deep(Math.min(panelAlpha + 0.1, 0.95))} !important;
        }

        /* Server folder expanded background */
        [class*="expandedFolderIconWrapper_"] {
            background: ${sec(panelAlpha * 0.8)} !important;
            background-color: ${sec(panelAlpha * 0.8)} !important;
        }

        /* Context menus, popovers, modals */
        [class*="menu_"][role="menu"],
        [class*="popout_"][class*="root_"],
        [class*="modal_"][class*="root_"] {
            background: ${flo(Math.min(panelAlpha + 0.15, 0.95))} !important;
            background-color: ${flo(Math.min(panelAlpha + 0.15, 0.95))} !important;
        }

        /* Tooltips */
        [class*="tooltip_"] {
            background: ${flo(0.95)} !important;
            background-color: ${flo(0.95)} !important;
        }

        /* Autocomplete / mention popup */
        [class*="autocomplete_"] {
            background: ${flo(Math.min(panelAlpha + 0.1, 0.95))} !important;
            background-color: ${flo(Math.min(panelAlpha + 0.1, 0.95))} !important;
        }

        /* Chat input box */
        [class*="channelTextArea_"] [class*="scrollableContainer_"] {
            background: ${ter(panelAlpha * 0.8)} !important;
            background-color: ${ter(panelAlpha * 0.8)} !important;
        }
    `);

    // STEP 2: Resolve the image and apply directly to <html>
    resolveImageUrl(imagePath).then(url => {
        if (url) {
            setHtmlBackground(url);
            console.log("[ZancordTheme] Background image applied:", url.slice(0, 60) + "...");
        }
    }).catch(e => {
        console.error("[ZancordTheme] All image loading methods failed:", e);
    });
}

function removeTheme() {
    for (const id of [THEME_STYLE_ID, OVERRIDE_STYLE_ID, EXTRA_STYLE_ID, BG_STYLE_ID, "zancord-bg-wallpaper"]) {
        styleCache[id]?.remove();
        styleCache[id] = null;
    }
    setHtmlBackground(null);
}

export const settings = definePluginSettings({
    palette: {
        type: OptionType.SELECT,
        description: "Color palette",
        options: Object.entries(palettes).map(([key, p]) => ({
            label: p.label,
            value: key,
            default: key === "deepOcean",
        })),
        onChange: () => applyTheme(),
    },
    backgroundImage: {
        type: OptionType.STRING,
        description: "Background image file path or URL (leave empty for solid background)",
        default: "https://plugins.zanverse.lol/assets/invader-zim-wallpaper.jpg",
        onChange: () => applyTheme(),
    },
    panelOpacity: {
        type: OptionType.SLIDER,
        description: "Panel transparency (lower = more see-through)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        default: 75,
        stickToMarkers: false,
        onChange: () => applyTheme(),
    },
    glowIntensity: {
        type: OptionType.SELECT,
        description: "Neon glow intensity on interactive elements",
        options: [
            { label: "Off", value: "off" },
            { label: "Subtle", value: "subtle", default: true },
            { label: "Full", value: "full" },
        ],
    },
});

export default definePlugin({
    name: "ZancordTheme",
    authors: [{ name: "Zan", id: 983426436306182144n }],
    description: "Synthwave cyberpunk theme for Zancord with background image support",
    enabledByDefault: true,
    settings,

    start() {
        console.log("[ZancordTheme] start()");
        applyTheme();
    },

    stop() {
        removeTheme();
    },
});
