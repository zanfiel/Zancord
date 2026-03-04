#!/usr/bin/env node
/**
 * Zancord Remote Plugin Bundler
 *
 * Scans remote-plugins/*.js, extracts metadata, computes SHA-256 hashes,
 * and generates/updates remote-plugins/manifest.json.
 *
 * Usage:
 *   node scripts/bundleRemotePlugins.mjs [--base-url URL] [--dir DIR]
 *
 * Options:
 *   --base-url  Base URL for downloadUrl (default: https://plugins.zanverse.lol/bundles)
 *   --dir       Plugin source directory (default: remote-plugins)
 *
 * Metadata is extracted from the JS files using these patterns:
 *   name:        return { name: "PluginName", ...
 *   description: return { ..., description: "...", ...
 *   version:     // @version 1.0.0  (header comment) OR version field in return object
 *   authors:     authors: [{ name: "Zan", ... }]  OR  // @author Zan
 *   tags:        // @tags tag1, tag2
 *   changelog:   // @changelog ...
 *   sourceUrl:   // @sourceUrl ...
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";

const args = process.argv.slice(2);

function getArg(name, fallback) {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return fallback;
}

const BASE_URL = getArg("base-url", "https://raw.githubusercontent.com/zanfiel/Zancord/main/remote-plugins");
const PLUGIN_DIR = getArg("dir", "remote-plugins");
const MANIFEST_PATH = join(PLUGIN_DIR, "manifest.json");

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

/**
 * Extract metadata from a plugin JS bundle.
 * Searches the full file text for known field patterns and header comments.
 * Does NOT try to parse nested JS objects — uses flat regex on the whole file.
 */
function extractMetadata(code, filename) {
    const fallbackName = basename(filename, extname(filename));

    // Name: first `name: "..."` in the file (outside comments)
    const nameMatch = code.match(/^\s*name:\s*["'`]([^"'`]+)["'`]/m);
    const pluginName = nameMatch ? nameMatch[1] : fallbackName;

    // Description: first `description: "..."` in the file
    const descMatch = code.match(/^\s*description:\s*["'`]([^"'`]+)["'`]/m);
    const description = descMatch ? descMatch[1] : "";

    // Version: header comment first, then object field
    const versionHeader = code.match(/\/\/\s*@version\s+(\S+)/);
    const versionField = code.match(/^\s*version:\s*["'`]([^"'`]+)["'`]/m);
    const version = (versionHeader && versionHeader[1]) || (versionField && versionField[1]) || "1.0.0";

    // Authors: find `authors: [...]` block, extract all `name: "..."` within
    const authors = [];
    const authorsArrayMatch = code.match(/authors:\s*\[([\s\S]*?)\]/);
    if (authorsArrayMatch) {
        for (const m of authorsArrayMatch[1].matchAll(/name:\s*["'`]([^"'`]+)["'`]/g)) {
            authors.push(m[1]);
        }
    }
    // Fallback: header comment // @author Name1, Name2
    if (authors.length === 0) {
        const authorHeader = code.match(/\/\/\s*@author\s+(.+)/);
        if (authorHeader) {
            authors.push(...authorHeader[1].split(",").map(s => s.trim()).filter(Boolean));
        }
    }
    if (authors.length === 0) authors.push("Unknown");

    // Tags from header comment
    const tagsHeader = code.match(/\/\/\s*@tags\s+(.+)/);
    const tags = tagsHeader
        ? tagsHeader[1].split(",").map(s => s.trim()).filter(Boolean)
        : undefined;

    // Changelog from header comment
    const changelogHeader = code.match(/\/\/\s*@changelog\s+(.+)/);
    const changelog = changelogHeader ? changelogHeader[1].trim() : undefined;

    // Source URL from header comment
    const sourceUrlHeader = code.match(/\/\/\s*@sourceUrl\s+(.+)/);
    const sourceUrl = sourceUrlHeader
        ? sourceUrlHeader[1].trim()
        : `https://github.com/zanfiel/Zancord/blob/main/${PLUGIN_DIR}/${filename}`;

    return { name: pluginName, description, version, authors, tags, changelog, sourceUrl };
}

async function main() {
    // Check plugin dir exists
    try {
        await stat(PLUGIN_DIR);
    } catch {
        console.error(`Error: Plugin directory "${PLUGIN_DIR}" not found.`);
        console.error("Run this script from the Zancord repo root.");
        process.exit(1);
    }

    // Read existing manifest to preserve fields not auto-detected
    let existingPlugins = {};
    try {
        const existing = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
        for (const p of existing.plugins || []) {
            existingPlugins[p.name] = p;
        }
    } catch {
        // No existing manifest, that's fine
    }

    // Scan for .js files
    const entries = await readdir(PLUGIN_DIR);
    const jsFiles = entries.filter(f => f.endsWith(".js")).sort();

    if (jsFiles.length === 0) {
        console.error("No .js plugin files found in", PLUGIN_DIR);
        process.exit(1);
    }

    const plugins = [];

    for (const file of jsFiles) {
        const filePath = join(PLUGIN_DIR, file);
        const code = await readFile(filePath, "utf-8");
        const hash = sha256(code);
        const meta = extractMetadata(code, file);
        const existing = existingPlugins[meta.name] || {};

        // Check for CSS companion file
        const cssFile = file.replace(/\.js$/, ".css");
        let cssUrl, cssHash;
        try {
            const cssCode = await readFile(join(PLUGIN_DIR, cssFile), "utf-8");
            cssUrl = `${BASE_URL}/${cssFile}`;
            cssHash = sha256(cssCode);
        } catch {
            // No CSS file
        }

        const entry = {
            name: meta.name,
            description: meta.description || existing.description || "",
            version: meta.version,
            authors: meta.authors,
            downloadUrl: `${BASE_URL}/${file}`,
            hash,
            ...(cssUrl && { cssUrl }),
            ...(cssHash && { cssHash }),
            ...(meta.tags && { tags: meta.tags }),
            ...(existing.tags && !meta.tags && { tags: existing.tags }),
            ...(meta.sourceUrl && { sourceUrl: meta.sourceUrl }),
            ...(meta.changelog && { changelog: meta.changelog }),
            ...(existing.changelog && !meta.changelog && { changelog: existing.changelog }),
            ...(existing.dependencies && { dependencies: existing.dependencies }),
            ...(existing.hasSettings !== undefined && { hasSettings: existing.hasSettings }),
            ...(existing.minZancordVersion && { minZancordVersion: existing.minZancordVersion }),
        };

        plugins.push(entry);
        const hashShort = hash.substring(0, 12);
        const changed = existing.hash && existing.hash !== hash;
        console.log(`  ${changed ? "UPDATED" : "OK"}  ${meta.name} v${meta.version} [${hashShort}...]`);
    }

    const manifest = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        plugins,
    };

    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 4) + "\n", "utf-8");

    console.log(`\nManifest written: ${MANIFEST_PATH}`);
    console.log(`  ${plugins.length} plugin(s), updated at ${manifest.updatedAt}`);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
