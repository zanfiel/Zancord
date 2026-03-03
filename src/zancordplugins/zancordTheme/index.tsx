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
import definePlugin, { OptionType, StartAt } from "@utils/types";

const THEME_STYLE_ID = "zancord-synthwave-vars";
const OVERRIDE_STYLE_ID = "zancord-synthwave-overrides";
const EXTRA_STYLE_ID = "zancord-synthwave-extra";

const styleCache: Record<string, HTMLStyleElement | null> = {};

// -- Synthwave Cyberpunk Palette --
const palettes = {
    neonNights: {
        label: "Neon Nights (Default)",
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
};

type PaletteKey = keyof typeof palettes;

function getPalette(key: string) {
    return palettes[key as PaletteKey] ?? palettes.neonNights;
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

async function getDiscordStyles(): Promise<string> {
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
    const texts = await Promise.all(
        Array.from(links, async node => node.href ? fetch(node.href).then(r => r.text()) : null)
    );
    return texts.filter(Boolean).join("\n");
}

const NEUTRAL_HSL_REGEX = /(--neutral-\d{1,3}?-hsl):.+?([\d.]+?)%;/g;

function applyTheme(paletteKey: string) {
    const p = getPalette(paletteKey);
    const bg = hexToHSL(p.bgPrimary);
    const accent = hexToHSL(p.accent);
    const accent2 = hexToHSL(p.accentSecondary);

    // Set base CSS variables
    setStyle(THEME_STYLE_ID, `:root {
        --zc-bg-deep: ${p.bgDeep};
        --zc-bg-primary: ${p.bgPrimary};
        --zc-bg-secondary: ${p.bgSecondary};
        --zc-bg-tertiary: ${p.bgTertiary};
        --zc-bg-floating: ${p.bgFloating};
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

            --background-primary: ${p.bgPrimary};
            --background-secondary: ${p.bgSecondary};
            --background-secondary-alt: ${p.bgTertiary};
            --background-tertiary: ${p.bgTertiary};
            --background-accent: ${p.bgFloating};
            --background-floating: ${p.bgFloating};
            --background-modifier-hover: ${p.accent}12;
            --background-modifier-active: ${p.accent}20;
            --background-modifier-selected: ${p.accent}18;
            --background-modifier-accent: ${p.border};

            --channeltextarea-background: ${p.bgTertiary};
            --input-background: ${p.bgTertiary};

            --scrollbar-thin-thumb: ${p.accent}44;
            --scrollbar-thin-track: transparent;
            --scrollbar-auto-thumb: ${p.accent}44;
            --scrollbar-auto-track: ${p.bgDeep};

            --focus-primary: ${p.accent};
            --control-brand-foreground: ${p.accent};
            --control-brand-foreground-new: ${p.accent};

            --mention-foreground: ${p.accent};
            --mention-background: ${p.accent}18;

            --info-positive-foreground: ${p.accentSecondary};
            --status-positive: ${p.accentSecondary};
        }
    `);
}

function removeTheme() {
    for (const id of [THEME_STYLE_ID, OVERRIDE_STYLE_ID, EXTRA_STYLE_ID]) {
        styleCache[id]?.remove();
        styleCache[id] = null;
    }
}

export const settings = definePluginSettings({
    palette: {
        type: OptionType.SELECT,
        description: "Color palette",
        options: Object.entries(palettes).map(([key, p]) => ({
            label: p.label,
            value: key,
            default: key === "neonNights",
        })),
        onChange: (val: string) => applyTheme(val),
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
    description: "Synthwave cyberpunk theme for Zancord",
    enabledByDefault: true,
    startAt: StartAt.DOMContentLoaded,

    start() {
        applyTheme(settings.store.palette ?? "neonNights");
    },

    stop() {
        removeTheme();
    },
});
