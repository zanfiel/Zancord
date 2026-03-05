#!/usr/bin/env node

/**
 * Zancord Remote Plugin Bundler
 *
 * Reads plugin sources from remote-plugins/src/<PluginName>/,
 * computes SHA-256 hashes, and generates a deployment-ready
 * remote-plugins/dist/ directory with manifest.json + bundles/*.js.
 *
 * Each plugin directory must contain:
 *   - index.js   — the plugin bundle (returned by new Function())
 *   - plugin.json — metadata (name, description, version, authors, tags, etc.)
 *   - (optional) style.css — plugin CSS
 *
 * Usage:
 *   node scripts/buildRemotePlugins.mjs [--base-url <url>] [--out <dir>]
 *
 * Options:
 *   --base-url   Base URL for downloadUrl/cssUrl in manifest
 *                 Default: https://plugins.zanverse.lol
 *   --out        Output directory (default: remote-plugins/dist)
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync } from "fs";
import { basename, join, resolve } from "path";

// -------------------------------------------------------------------
// CLI argument parsing
// -------------------------------------------------------------------

const args = process.argv.slice(2);
let baseUrl = "https://plugins.zanverse.lol";
let outDir = "remote-plugins/dist";

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
        baseUrl = args[++i].replace(/\/+$/, "");
    } else if (args[i] === "--out" && args[i + 1]) {
        outDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
        console.log(`
Zancord Remote Plugin Bundler

Usage: node scripts/buildRemotePlugins.mjs [options]

Options:
  --base-url <url>   Base URL for download links (default: https://plugins.zanverse.lol)
  --out <dir>        Output directory (default: remote-plugins/dist)
  -h, --help         Show this help
`);
        process.exit(0);
    }
}

// -------------------------------------------------------------------
// Paths
// -------------------------------------------------------------------

const projectRoot = resolve(import.meta.dirname, "..");
const srcDir = join(projectRoot, "remote-plugins", "src");
const outputDir = resolve(projectRoot, outDir);
const bundlesDir = join(outputDir, "bundles");

// -------------------------------------------------------------------
// SHA-256 helper
// -------------------------------------------------------------------

function sha256(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

function main() {
    console.log("=== Zancord Remote Plugin Bundler ===\n");

    if (!existsSync(srcDir)) {
        console.error(`Error: Source directory not found: ${srcDir}`);
        console.error("Create plugin directories under remote-plugins/src/<PluginName>/");
        process.exit(1);
    }

    // Ensure output directories exist
    mkdirSync(bundlesDir, { recursive: true });

    const pluginDirs = readdirSync(srcDir).filter(entry => {
        const full = join(srcDir, entry);
        return statSync(full).isDirectory();
    });

    if (pluginDirs.length === 0) {
        console.warn("No plugin directories found in", srcDir);
        process.exit(0);
    }

    console.log(`Found ${pluginDirs.length} plugin(s) in ${srcDir}\n`);

    const manifestEntries = [];
    let errors = 0;

    for (const dir of pluginDirs) {
        const pluginDir = join(srcDir, dir);
        const metaPath = join(pluginDir, "plugin.json");
        const indexPath = join(pluginDir, "index.js");
        const cssPath = join(pluginDir, "style.css");

        // Validate required files
        if (!existsSync(metaPath)) {
            console.error(`  [SKIP] ${dir}: missing plugin.json`);
            errors++;
            continue;
        }
        if (!existsSync(indexPath)) {
            console.error(`  [SKIP] ${dir}: missing index.js`);
            errors++;
            continue;
        }

        // Read and validate metadata
        let meta;
        try {
            meta = JSON.parse(readFileSync(metaPath, "utf8"));
        } catch (e) {
            console.error(`  [SKIP] ${dir}: invalid plugin.json — ${e.message}`);
            errors++;
            continue;
        }

        const requiredFields = ["name", "description", "version", "authors"];
        const missing = requiredFields.filter(f => !meta[f]);
        if (missing.length > 0) {
            console.error(`  [SKIP] ${dir}: plugin.json missing fields: ${missing.join(", ")}`);
            errors++;
            continue;
        }

        // Validate that plugin name matches directory name
        if (meta.name !== dir) {
            console.warn(`  [WARN] ${dir}: plugin.json name "${meta.name}" does not match directory name "${dir}"`);
        }

        // Read JS bundle
        const jsContent = readFileSync(indexPath, "utf8");
        const jsHash = sha256(jsContent);

        // Quick validation: try to parse as a function body
        try {
            new Function(`"use strict"; return (function() { ${jsContent} })();`);
        } catch (e) {
            console.error(`  [SKIP] ${dir}: index.js has syntax errors — ${e.message}`);
            errors++;
            continue;
        }

        // Write bundle to output
        const bundleFilename = `${meta.name}.js`;
        writeFileSync(join(bundlesDir, bundleFilename), jsContent, "utf8");

        // Build manifest entry
        const entry = {
            name: meta.name,
            description: meta.description,
            version: meta.version,
            authors: meta.authors,
            downloadUrl: `${baseUrl}/bundles/${bundleFilename}`,
            hash: jsHash,
        };

        // Handle optional CSS
        if (existsSync(cssPath)) {
            const cssContent = readFileSync(cssPath, "utf8");
            const cssHash = sha256(cssContent);
            const cssFilename = `${meta.name}.css`;

            writeFileSync(join(bundlesDir, cssFilename), cssContent, "utf8");

            entry.cssUrl = `${baseUrl}/bundles/${cssFilename}`;
            entry.cssHash = cssHash;
        }

        // Optional fields
        if (meta.tags) entry.tags = meta.tags;
        if (meta.sourceUrl) entry.sourceUrl = meta.sourceUrl;
        if (meta.changelog) entry.changelog = meta.changelog;
        if (meta.minZancordVersion) entry.minZancordVersion = meta.minZancordVersion;
        if (meta.dependencies) entry.dependencies = meta.dependencies;
        if (meta.hasSettings) entry.hasSettings = meta.hasSettings;

        manifestEntries.push(entry);

        const cssNote = entry.cssUrl ? " + CSS" : "";
        console.log(`  [OK] ${meta.name} v${meta.version} — ${jsHash.slice(0, 12)}...${cssNote}`);
    }

    // Generate manifest
    const manifest = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        plugins: manifestEntries,
    };

    const manifestJson = JSON.stringify(manifest, null, 4) + "\n";
    writeFileSync(join(outputDir, "manifest.json"), manifestJson, "utf8");

    console.log(`\n--- Results ---`);
    console.log(`  Plugins built: ${manifestEntries.length}`);
    if (errors > 0) console.log(`  Skipped:       ${errors}`);
    console.log(`  Output:        ${outputDir}`);
    console.log(`  Manifest:      ${join(outputDir, "manifest.json")}`);
    console.log(`  Bundles:       ${bundlesDir}`);
    console.log(`  Base URL:      ${baseUrl}`);
    console.log();

    if (errors > 0) {
        process.exit(1);
    }
}

main();
