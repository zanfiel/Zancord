/**
 * Zancord Offline Patch Validator v3
 * 
 * Downloads Discord's webpack bundles and tests all Zancord plugin patches
 * against them WITHOUT running Discord. Reports which patches would break.
 * 
 * Usage:
 *   node validate.mjs [--canary] [--verbose] [--skip-download]
 *   node validate.mjs --compare [--verbose] [--skip-download]
 *   node validate.mjs --json [--canary|--compare]
 * 
 * Modes:
 *   (default)   Validate patches against Stable
 *   --canary    Validate patches against Canary
 *   --compare   Run both Stable + Canary, show only NEW breaks on Canary
 *   --json      Output results as JSON to stdout (for CI/CD)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import https from "https";
import http from "http";
import vm from "vm";
import { hash as h64 } from "@intrnl/xxhash64";

// ============================================================
// Configuration
// ============================================================

const DISCORD_CHANNELS = {
    stable: "https://discord.com/app",
    canary: "https://canary.discord.com/app",
};

// ZANCORD_SRC env var for CI, fallback to local path
const ZANCORD_SRC = resolve(process.env.ZANCORD_SRC || "C:/Users/Zan/Zancord-src");
const CACHE_DIR = resolve(process.env.VALIDATOR_CACHE_DIR || "C:/Users/Zan/zancord-validator/cache");
const PLUGIN_DIRS = [
    join(ZANCORD_SRC, "src/plugins"),
    join(ZANCORD_SRC, "src/zancordplugins"),
];

// ============================================================
// Argument parsing
// ============================================================

const args = process.argv.slice(2);
const COMPARE_MODE = args.includes("--compare");
const CHANNEL = args.includes("--canary") ? "canary" : "stable";
const VERBOSE = args.includes("--verbose") || args.includes("-v");
const SKIP_DOWNLOAD = args.includes("--skip-download");
const JSON_OUTPUT = args.includes("--json");

// ============================================================
// HTTP helpers
// ============================================================

function httpFetch(url) {
    return new Promise((res, rej) => {
        const mod = url.startsWith("https") ? https : http;
        const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return httpFetch(response.headers.location).then(res, rej);
            }
            if (response.statusCode !== 200) {
                return rej(new Error(`HTTP ${response.statusCode} for ${url}`));
            }
            const chunks = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
            response.on("error", rej);
        });
        req.on("error", rej);
        req.setTimeout(60000, () => { req.destroy(); rej(new Error("Timeout")); });
    });
}

// ============================================================
// Step 1: Get Discord build info
// ============================================================

async function getDiscordBuild(channel) {
    if (!JSON_OUTPUT) console.log(`\nFetching Discord ${channel} build info...`);
    const url = DISCORD_CHANNELS[channel];
    const html = await httpFetch(url);

    const buildMatch = html.match(/"BUILD_NUMBER":"(\d+)"/);
    const hashMatch = html.match(/"VERSION_HASH":"([a-f0-9]+)"/);
    const releaseMatch = html.match(/"RELEASE_CHANNEL":"(\w+)"/);

    const scriptMatches = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)];
    const preloadMatches = [...html.matchAll(/href="(\/assets\/[^"]+\.js)"\s+rel="preload"/g)];

    const baseUrl = channel === "canary" ? "https://canary.discord.com" : "https://discord.com";
    const allScripts = [...new Set([...preloadMatches, ...scriptMatches].map(m => baseUrl + m[1]))];
    const webBundle = allScripts.find(s => /\/web\.[a-f0-9]+\.js/.test(s));

    const buildNumber = buildMatch ? parseInt(buildMatch[1]) : 0;
    const versionHash = hashMatch ? hashMatch[1] : "unknown";

    if (!JSON_OUTPUT) {
        console.log(`  Channel: ${releaseMatch?.[1] || channel}`);
        console.log(`  Build: ${buildNumber}`);
        console.log(`  Version: ${versionHash.substring(0, 12)}...`);
        console.log(`  Main bundle: ${webBundle?.split("/").pop()}`);
    }

    return { buildNumber, versionHash, webBundle, allScripts, baseUrl, channel };
}

// ============================================================
// Step 2: Download bundle with caching
// ============================================================

async function downloadBundle(url, cacheKey) {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

    const filename = url.split("/").pop();
    const cachePath = join(CACHE_DIR, `${cacheKey}_${filename}`);

    if (SKIP_DOWNLOAD && existsSync(cachePath)) {
        if (!JSON_OUTPUT) console.log(`  Using cached: ${filename}`);
        return readFileSync(cachePath, "utf8");
    }

    if (existsSync(cachePath)) {
        if (!JSON_OUTPUT) console.log(`  Using cached: ${filename}`);
        return readFileSync(cachePath, "utf8");
    }

    if (!JSON_OUTPUT) console.log(`  Downloading: ${filename} ...`);
    const content = await httpFetch(url);
    writeFileSync(cachePath, content);
    return content;
}

// ============================================================
// Step 3: Extract webpack module factories using vm sandboxing
// ============================================================

/**
 * Extract module factories from the main webpack bundle.
 * 
 * Strategy: We use vm.runInNewContext to evaluate a modified version of
 * the bundle that captures the __webpack_modules__ object instead of
 * executing the full webpack runtime.
 * 
 * The bundle is: (()=>{ var __webpack_modules__={...}; ...webpack runtime... })();
 * We modify it to capture __webpack_modules__ before the runtime executes.
 */
function extractModuleFactories(code) {
    const modules = new Map();

    // Strategy: Regex-based boundary detection.
    // Instead of fragile brace-counting on 15MB of minified JS, we find module
    // boundaries using the distinctive pattern that separates module factories.
    //
    // Discord's webpack (rspack) uses shorthand method syntax:
    //   { 714694(e,t,n){...}, 983660(e,t,n){...} }
    //
    // Module transitions look like: },DIGITS( or },"STRING"( or },DIGITS:
    // The },ID( pattern is extremely unlikely to appear inside a module factory
    // because it would mean a } at end of expression followed by a comma and then
    // a numeric literal used as a function call — which isn't valid JS.
    //
    // Approach:
    // 1. Find all module ID positions using regex on the whole __webpack_modules__ range
    // 2. Between consecutive IDs, extract the factory source

    const modulesStart = code.indexOf("var __webpack_modules__={");
    if (modulesStart === -1) return modules;

    const objStart = modulesStart + "var __webpack_modules__={".length;
    
    // Find the webpack runtime start (marks end of __webpack_modules__)
    // The runtime starts with var __webpack_module_cache__ or uses __webpack_modules__[
    // In rspack, look for the pattern after the closing } of __webpack_modules__
    // We know __webpack_require__ starts around position 15.4M
    const runtimeMarker = code.indexOf("__webpack_require__", objStart);
    const searchEnd = runtimeMarker !== -1 ? runtimeMarker : code.length;

    // Find all module boundaries.
    // Pattern: at start of object, or after }, find: ID( or ID:
    // ID can be: digits, digits with scientific notation (367e3), or quoted string
    // We use a regex that matches the boundary pattern.
    //
    // First module starts right at objStart: ID(
    // Subsequent modules are after },  : },ID(
    const boundaryRegex = /(?:^|},?)(\d+(?:e\d+)?|"[^"]*"|'[^']*')(\(|:)/g;
    
    // We need to search in the region from objStart to searchEnd
    // But running regex on a 15MB substring is fine
    const region = code.substring(objStart, searchEnd);
    
    // Collect all module positions
    const modulePositions = [];
    let m;
    while ((m = boundaryRegex.exec(region)) !== null) {
        const id = m[1].replace(/^["']|["']$/g, ""); // strip quotes if any
        const idStartInRegion = m.index + m[0].length - m[1].length - m[2].length;
        const absPos = objStart + m.index;
        modulePositions.push({
            id,
            // The factory source starts at the ID itself
            sourceStart: objStart + idStartInRegion,
            matchEnd: objStart + m.index + m[0].length,
        });
    }

    // Now extract module sources between consecutive boundaries
    for (let idx = 0; idx < modulePositions.length; idx++) {
        const curr = modulePositions[idx];
        // The factory source runs from the ID start to just before the next module's ID
        // (or to the end of __webpack_modules__)
        let endPos;
        if (idx + 1 < modulePositions.length) {
            // Find the }, before the next module ID
            endPos = modulePositions[idx + 1].sourceStart;
            // Back up past the comma and closing brace
            while (endPos > curr.sourceStart && code.charCodeAt(endPos - 1) !== 125 /* } */) endPos--;
            if (endPos > curr.sourceStart) endPos; // endPos is now at the } + 1
        } else {
            // Last module — find its closing } before the ; or end
            // The __webpack_modules__ object ends with };
            endPos = searchEnd;
            // Walk back to find the closing }
            let p = searchEnd - 1;
            while (p > curr.sourceStart && code.charCodeAt(p) !== 125) p--;
            endPos = p + 1; // include the }
        }
        
        const src = code.substring(curr.sourceStart, endPos);
        if (src.length > 0) {
            modules.set(curr.id, src);
        }
    }

    return modules;
}

/**
 * Extract module factories from a webpack lazy chunk.
 * Format: (this.webpackChunkdiscord_app=this.webpackChunkdiscord_app||[]).push([[chunkId],{...modules...}])
 */
function extractChunkModules(code) {
    // Find the modules object after the chunk IDs array
    const pushIdx = code.indexOf(".push([[");
    if (pushIdx === -1) return new Map();
    
    // Find the },{ that separates chunk IDs from modules
    let i = pushIdx + 8;
    let bracketDepth = 1;
    // Skip past the chunk IDs array
    while (i < code.length && bracketDepth > 0) {
        if (code.charCodeAt(i) === 91) bracketDepth++;
        else if (code.charCodeAt(i) === 93) bracketDepth--;
        i++;
    }
    // Now i is after the ], skip comma
    while (i < code.length && code.charCodeAt(i) !== 123) i++;
    
    if (i >= code.length) return new Map();
    
    // Now extract modules from position i (which is {)
    // Reuse the same brace-tracking logic from extractModuleFactories
    // but starting from this position
    const fakeCode = "var __webpack_modules__=" + code.substring(i);
    return extractModuleFactories(fakeCode);
}

/**
 * Extract the chunk map from the webpack runtime.
 * Maps chunk IDs to their asset filenames.
 */
function extractChunkMap(code, baseUrl) {
    const chunkMap = new Map();
    
    // The chunk map is in __webpack_require__.u which maps chunk IDs to asset hashes
    // Pattern: __webpack_require__.u=e=>""+({...})[e]+".js"
    // But the map can be large, let's find it
    const uIdx = code.indexOf("__webpack_require__.u=");
    if (uIdx === -1) return chunkMap;
    
    // Find the object literal within it
    const objStart = code.indexOf("{", uIdx);
    if (objStart === -1 || objStart > uIdx + 200) return chunkMap;
    
    // Find matching }
    let depth = 1;
    let i = objStart + 1;
    while (i < code.length && depth > 0) {
        if (code.charCodeAt(i) === 123) depth++;
        else if (code.charCodeAt(i) === 125) depth--;
        i++;
    }
    
    const mapStr = code.substring(objStart, i);
    
    // Parse entries like: 10016:"b46eef9b6e473607"
    const entryRegex = /(\w+):"([a-f0-9]+)"/g;
    let m;
    while ((m = entryRegex.exec(mapStr)) !== null) {
        chunkMap.set(m[1], `${baseUrl}/assets/${m[2]}.js`);
    }
    
    return chunkMap;
}

// ============================================================
// Step 4: Extract patches from Zancord plugin source
// ============================================================

// Intl hash support — mirrors src/utils/intlHash.ts
const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
const IS_BIG_ENDIAN = (() => {
    const array = new Uint8Array(4);
    const view = new Uint32Array(array.buffer);
    return !((view[0] = 1) & array[0]);
})();

function numberToBytes(number) {
    number = BigInt(number);
    const array = [];
    const byteCount = Math.ceil(Math.floor(Math.log2(Number(number)) + 1) / 8);
    for (let i = 0; i < byteCount; i++) {
        array.unshift(Number((number >> BigInt(8 * i)) & BigInt(255)));
    }
    const bytes = new Uint8Array(array);
    return IS_BIG_ENDIAN ? bytes : bytes.reverse();
}

function runtimeHashMessageKey(key) {
    const hash = h64(key, 0);
    const bytes = numberToBytes(hash);
    return [
        BASE64_TABLE[bytes[0] >> 2],
        BASE64_TABLE[((bytes[0] & 0x03) << 4) | (bytes[1] >> 4)],
        BASE64_TABLE[((bytes[1] & 0x0f) << 2) | (bytes[2] >> 6)],
        BASE64_TABLE[bytes[2] & 0x3f],
        BASE64_TABLE[bytes[3] >> 2],
        BASE64_TABLE[((bytes[3] & 0x03) << 4) | (bytes[4] >> 4)],
    ].join("");
}

function canonicalizeMatch(match) {
    const isString = typeof match === "string";
    let source = isString ? match : match.source;

    // Expand #{intl::KEY} and #{intl::KEY::modifier} patterns
    source = source.replace(/#{intl::([\w$+/]*)(?:::(\w+))?}/g, (_, key, modifier) => {
        const hashed = modifier === "raw" ? key : runtimeHashMessageKey(key);
        if (modifier === "hash") return hashed;

        const hasSpecialChars = !Number.isNaN(Number(hashed[0])) || hashed.includes("+") || hashed.includes("/");

        if (hasSpecialChars) {
            return isString
                ? `["${hashed}"]`
                : `(?:\\["${hashed.replace(/\+/g, "\\+")}"\\])`;
        }

        return isString ? `.${hashed}` : `(?:\\.${hashed})`;
    });

    if (isString) {
        return { value: source, hasIntl: false };
    }

    // Expand \i to identifier matcher
    source = source.replace(/(\\*)\\i/g, (m, leadingEscapes) =>
        leadingEscapes.length % 2 === 0
            ? `${leadingEscapes}(?:[A-Za-z_$][\\w$]*)`
            : m.slice(1)
    );

    return { value: new RegExp(source, match.flags), hasIntl: false };
}

function extractPatchesFromSource(filePath, content) {
    const patches = [];
    const parts = filePath.replace(/\\/g, "/").split("/");
    const pluginName = parts.slice(-2).join("/");
    
    if (!content.includes("patches") || !content.includes("find")) return patches;
    
    // First pass: collect ALL find: positions and their parsed values
    // This lets us use the next find: position as a boundary for each patch's scope
    const findEntries = [];
    
    // String finds (double-quoted)
    const stringFindDQ = /find:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = stringFindDQ.exec(content)) !== null) {
        const raw = m[1];
        const findValue = raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        const line = content.substring(0, m.index).split("\n").length;
        const canon = canonicalizeMatch(findValue);
        findEntries.push({ pos: m.index, find: canon.value, findType: "string", hasIntl: canon.hasIntl, line });
    }
    
    // String finds (single-quoted)  
    const stringFindSQ = /find:\s*'((?:[^'\\]|\\.)*)'/g;
    while ((m = stringFindSQ.exec(content)) !== null) {
        const raw = m[1];
        const findValue = raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const line = content.substring(0, m.index).split("\n").length;
        const canon = canonicalizeMatch(findValue);
        findEntries.push({ pos: m.index, find: canon.value, findType: "string", hasIntl: canon.hasIntl, line });
    }
    
    // Regex finds
    const regexFind = /find:\s*\/((?:[^/\\]|\\.)*)\/([gimsuy]*)/g;
    while ((m = regexFind.exec(content)) !== null) {
        const line = content.substring(0, m.index).split("\n").length;
        try {
            const canon = canonicalizeMatch(new RegExp(m[1], m[2]));
            findEntries.push({ pos: m.index, find: canon.value, findType: "regex", hasIntl: canon.hasIntl, line });
        } catch (e) {
            findEntries.push({ pos: m.index, find: m[0], findType: "regex", error: e.message, hasIntl: false, line });
        }
    }
    
    // Sort by position so we can use consecutive finds as boundaries
    findEntries.sort((a, b) => a.pos - b.pos);
    
    // Second pass: extract match: patterns scoped between consecutive find: positions
    for (let i = 0; i < findEntries.length; i++) {
        const entry = findEntries[i];
        const scopeStart = entry.pos;
        const scopeEnd = i + 1 < findEntries.length ? findEntries[i + 1].pos : Math.min(scopeStart + 8000, content.length);
        const replacements = extractReplacements(content.substring(scopeStart, scopeEnd));
        
        patches.push({
            plugin: pluginName,
            file: filePath,
            find: entry.find,
            findType: entry.findType,
            hasIntl: entry.hasIntl,
            error: entry.error,
            replacements,
            line: entry.line,
        });
    }
    
    return patches;
}

function extractReplacements(patchText) {
    const replacements = [];

    // Regex match patterns
    const regexMatchPat = /match:\s*\/((?:[^/\\]|\\.)*)\/([gimsuy]*)/g;
    let m;
    while ((m = regexMatchPat.exec(patchText)) !== null) {
        try {
            const canon = canonicalizeMatch(new RegExp(m[1], m[2]));
            replacements.push({ match: canon.value, matchType: "regex", hasIntl: canon.hasIntl });
        } catch (e) {
            replacements.push({ match: m[0], matchType: "regex", error: e.message });
        }
    }

    // String match patterns (double-quoted)
    const stringMatchDQ = /match:\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = stringMatchDQ.exec(patchText)) !== null) {
        let val = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const canon = canonicalizeMatch(val);
        replacements.push({ match: canon.value, matchType: "string", hasIntl: canon.hasIntl });
    }

    // String match patterns (single-quoted)
    const stringMatchSQ = /match:\s*'((?:[^'\\]|\\.)*)'/g;
    while ((m = stringMatchSQ.exec(patchText)) !== null) {
        let val = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const canon = canonicalizeMatch(val);
        replacements.push({ match: canon.value, matchType: "string", hasIntl: canon.hasIntl });
    }

    return replacements;
}

function findPluginFiles(dir) {
    const files = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (entry === "node_modules" || entry === ".git") continue;
            files.push(...findPluginFiles(fullPath));
        } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") && !entry.includes(".test.")) {
            files.push(fullPath);
        }
    }
    return files;
}

// ============================================================
// Step 5: Validate patches
// ============================================================

function validatePatches(modules, patches, buildNumber) {
    if (!JSON_OUTPUT) console.log(`\nValidating ${patches.length} patches against ${modules.size} modules...`);

    const results = {
        working: [],
        broken_find: [],
        broken_match: [],
        intl_skipped: [],
        parse_error: [],
        multiple_finds: [],
    };

    // Pre-collect module sources as array for fast iteration
    const moduleSources = [...modules.values()];

    for (const patch of patches) {
        if (patch.error) { results.parse_error.push(patch); continue; }
        if (patch.hasIntl) { results.intl_skipped.push(patch); continue; }

        // Test find
        let foundModules = [];
        if (patch.findType === "string") {
            foundModules = moduleSources.filter(src => src.includes(patch.find));
        } else if (patch.findType === "regex") {
            foundModules = moduleSources.filter(src => {
                patch.find.lastIndex = 0;
                return patch.find.test(src);
            });
        }

        if (foundModules.length === 0) {
            results.broken_find.push(patch);
            continue;
        }

        if (foundModules.length > 1) {
            results.multiple_finds.push({ ...patch, matchCount: foundModules.length });
        }

        // Test replacements
        let allWork = true;
        let broken = [];

        for (const repl of patch.replacements) {
            if (repl.error) { allWork = false; broken.push(repl); continue; }
            if (repl.hasIntl) continue;

            let matched = false;
            for (const src of foundModules) {
                if (repl.matchType === "string") {
                    if (src.includes(repl.match)) { matched = true; break; }
                } else if (repl.matchType === "regex") {
                    repl.match.lastIndex = 0;
                    if (repl.match.test(src)) { matched = true; break; }
                }
            }
            if (!matched) { allWork = false; broken.push(repl); }
        }

        if (allWork) {
            results.working.push(patch);
        } else {
            results.broken_match.push({ ...patch, brokenReplacements: broken });
        }
    }

    return results;
}

// ============================================================
// Step 6: Report
// ============================================================

function printReport(results, buildInfo) {
    const total = results.working.length + results.broken_find.length +
        results.broken_match.length + results.intl_skipped.length + results.parse_error.length;

    const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";

    console.log(`\n${"=".repeat(70)}`);
    console.log(`  ZANCORD PATCH VALIDATION REPORT`);
    console.log(`  Discord ${buildInfo.channel.toUpperCase()} — Build ${buildInfo.buildNumber}`);
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${"=".repeat(70)}\n`);

    console.log(`  WORKING:        ${String(results.working.length).padStart(4)} (${pct(results.working.length)}%)`);
    console.log(`  BROKEN (find):  ${String(results.broken_find.length).padStart(4)} (${pct(results.broken_find.length)}%)  -- module not found`);
    console.log(`  BROKEN (match): ${String(results.broken_match.length).padStart(4)} (${pct(results.broken_match.length)}%)  -- module found, pattern failed`);
    console.log(`  INTL SKIPPED:   ${String(results.intl_skipped.length).padStart(4)} (${pct(results.intl_skipped.length)}%)  -- uses intl hash`);
    console.log(`  PARSE ERROR:    ${String(results.parse_error.length).padStart(4)} (${pct(results.parse_error.length)}%)`);
    console.log(`  MULTI-FIND:     ${String(results.multiple_finds.length).padStart(4)}       -- find matched >1 module`);
    console.log(`  ${"─".repeat(40)}`);
    console.log(`  TOTAL:          ${String(total).padStart(4)}\n`);

    if (results.broken_find.length > 0) {
        console.log(`  BROKEN FINDS (module not found):`);
        console.log(`  ${"─".repeat(60)}`);
        for (const p of results.broken_find) {
            const findStr = typeof p.find === "string"
                ? `"${p.find.length > 80 ? p.find.substring(0, 80) + "..." : p.find}"`
                : `/${(p.find.source.length > 80 ? p.find.source.substring(0, 80) + "..." : p.find.source)}/`;
            console.log(`  ${p.plugin}:${p.line}  find: ${findStr}`);
        }
    }

    if (results.broken_match.length > 0) {
        console.log(`\n  BROKEN MATCHES (module found, pattern failed):`);
        console.log(`  ${"─".repeat(60)}`);
        for (const p of results.broken_match) {
            const findStr = typeof p.find === "string"
                ? `"${p.find.length > 80 ? p.find.substring(0, 80) + "..." : p.find}"`
                : `/${(p.find.source.length > 80 ? p.find.source.substring(0, 80) + "..." : p.find.source)}/`;
            console.log(`  ${p.plugin}:${p.line}  find: ${findStr}`);
            for (const r of p.brokenReplacements) {
                const ms = r.match instanceof RegExp
                    ? `/${r.match.source.length > 60 ? r.match.source.substring(0, 60) + "..." : r.match.source}/`
                    : `"${String(r.match).substring(0, 60)}"`;
                console.log(`    broken match: ${ms}${r.error ? ` (${r.error})` : ""}`);
            }
        }
    }

    console.log(`\n${"=".repeat(70)}`);
    const broken = results.broken_find.length + results.broken_match.length;
    if (broken === 0) {
        console.log("  VERDICT: ALL PATCHES PASS -- Safe to update Discord");
    } else {
        console.log(`  VERDICT: ${broken} BROKEN PATCH${broken !== 1 ? "ES" : ""} -- DO NOT UPDATE until fixed`);
    }
    console.log(`${"=".repeat(70)}\n`);

    return broken;
}

// ============================================================
// Main
// ============================================================

// ============================================================
// Reusable pipeline functions
// ============================================================

/**
 * Extract all patches from Zancord source (channel-independent).
 */
function extractAllPatches(label) {
    if (!JSON_OUTPUT) console.log(`\n[${label}] Extracting patches from Zancord source...`);
    const allPatches = [];
    for (const dir of PLUGIN_DIRS) {
        const files = findPluginFiles(dir);
        if (!JSON_OUTPUT) console.log(`  Scanning ${files.length} files in ${dir.split(/[/\\]/).pop()}/`);
        for (const file of files) {
            try {
                const content = readFileSync(file, "utf8");
                const patches = extractPatchesFromSource(file, content);
                allPatches.push(...patches);
            } catch (e) {
                if (VERBOSE) console.log(`  Warning: ${file}: ${e.message}`);
            }
        }
    }
    if (!JSON_OUTPUT) console.log(`  Total patches extracted: ${allPatches.length}`);
    return allPatches;
}

/**
 * Download Discord bundles and extract all webpack modules for a given channel.
 * Returns { buildInfo, modules }.
 */
async function downloadAndExtractModules(channel, stepPrefix) {
    const sp = stepPrefix || "";
    const buildInfo = await getDiscordBuild(channel);
    if (JSON_OUTPUT) {
        // Suppress download output in JSON mode
    }

    // Download main bundle
    if (!JSON_OUTPUT) console.log(`\n${sp}Downloading ${channel} webpack bundles...`);
    const mainCode = await downloadBundle(buildInfo.webBundle, `${channel}_main`);
    if (!JSON_OUTPUT) console.log(`  Main bundle: ${(mainCode.length / 1024 / 1024).toFixed(1)} MB`);

    // Extract module factories
    if (!JSON_OUTPUT) console.log(`${sp}Extracting ${channel} webpack module factories...`);
    const t0 = Date.now();
    const modules = extractModuleFactories(mainCode);
    const t1 = Date.now();
    if (!JSON_OUTPUT) console.log(`  Extracted ${modules.size} modules from main bundle in ${t1 - t0}ms`);

    // Chunk map
    const chunkMap = extractChunkMap(mainCode, buildInfo.baseUrl);
    if (!JSON_OUTPUT) console.log(`  Found ${chunkMap.size} lazy chunk entries`);

    // Download all lazy chunks
    const allChunkEntries = [...chunkMap.entries()];
    if (allChunkEntries.length > 0) {
        const CONCURRENCY = 20;
        let chunkModuleCount = 0;
        let downloaded = 0;
        let cached = 0;
        let failed = 0;

        if (!JSON_OUTPUT) console.log(`  Downloading ALL ${allChunkEntries.length} lazy chunks (concurrency: ${CONCURRENCY})...`);

        for (let i = 0; i < allChunkEntries.length; i += CONCURRENCY) {
            const batch = allChunkEntries.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(async ([chunkId, url]) => {
                    const cacheKey = `${channel}_chunk_${chunkId}`;
                    const filename = url.split("/").pop();
                    const cachePath = join(CACHE_DIR, `${cacheKey}_${filename}`);

                    let chunkCode;
                    if (existsSync(cachePath)) {
                        chunkCode = readFileSync(cachePath, "utf8");
                        cached++;
                    } else {
                        chunkCode = await httpFetch(url);
                        writeFileSync(cachePath, chunkCode);
                        downloaded++;
                    }

                    const chunkModules = extractChunkModules(chunkCode);
                    return chunkModules;
                })
            );

            for (const result of results) {
                if (result.status === "fulfilled") {
                    for (const [id, src] of result.value) {
                        modules.set(id, src);
                    }
                    chunkModuleCount += result.value.size;
                } else {
                    failed++;
                }
            }

            // Progress indicator every 200 chunks
            if (!JSON_OUTPUT) {
                const done = Math.min(i + CONCURRENCY, allChunkEntries.length);
                if (done % 200 === 0 || done === allChunkEntries.length) {
                    process.stdout.write(`\r  Progress: ${done}/${allChunkEntries.length} chunks (${cached} cached, ${downloaded} downloaded, ${failed} failed)`);
                }
            }
        }
        if (!JSON_OUTPUT) console.log(`\n  Added ${chunkModuleCount} modules from ${allChunkEntries.length} lazy chunks (total: ${modules.size})`);
    }

    return { buildInfo, modules };
}

/**
 * Build a serializable report object from validation results.
 */
function buildReportObject(results, buildInfo) {
    const total = results.working.length + results.broken_find.length +
        results.broken_match.length + results.intl_skipped.length + results.parse_error.length;
    return {
        timestamp: new Date().toISOString(),
        channel: buildInfo.channel,
        buildNumber: buildInfo.buildNumber,
        versionHash: buildInfo.versionHash,
        total,
        summary: {
            working: results.working.length,
            broken_find: results.broken_find.length,
            broken_match: results.broken_match.length,
            intl_skipped: results.intl_skipped.length,
            parse_error: results.parse_error.length,
            multiple_finds: results.multiple_finds.length,
        },
        broken_finds: results.broken_find.map(p => ({
            plugin: p.plugin, line: p.line,
            find: typeof p.find === "string" ? p.find : p.find.source,
        })),
        broken_matches: results.broken_match.map(p => ({
            plugin: p.plugin, line: p.line,
            find: typeof p.find === "string" ? p.find : p.find.source,
            brokenReplacements: (p.brokenReplacements || []).map(r => ({
                match: r.match instanceof RegExp ? r.match.source : String(r.match),
                error: r.error,
            })),
        })),
    };
}

/**
 * Create a unique key for a patch (plugin:line).
 */
function patchKey(p) {
    return `${p.plugin}:${p.line}`;
}

// ============================================================
// Compare mode: diff Stable vs Canary
// ============================================================

function printCompareReport(stableReport, canaryReport, newBrokenFinds, newBrokenMatches, fixedPatches) {
    const stableBroken = stableReport.summary.broken_find + stableReport.summary.broken_match;
    const canaryBroken = canaryReport.summary.broken_find + canaryReport.summary.broken_match;
    const newBrokenTotal = newBrokenFinds.length + newBrokenMatches.length;
    const fixedTotal = fixedPatches.length;

    console.log(`\n${"=".repeat(70)}`);
    console.log(`  ZANCORD PATCH COMPARISON REPORT`);
    console.log(`  Stable (Build ${stableReport.buildNumber}) vs Canary (Build ${canaryReport.buildNumber})`);
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${"=".repeat(70)}\n`);

    console.log(`  STABLE:  ${String(stableReport.summary.working).padStart(4)} working, ${String(stableBroken).padStart(3)} broken  (${stableReport.total} total)`);
    console.log(`  CANARY:  ${String(canaryReport.summary.working).padStart(4)} working, ${String(canaryBroken).padStart(3)} broken  (${canaryReport.total} total)`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  NEW BREAKS on Canary:  ${newBrokenTotal}`);
    console.log(`  FIXED on Canary:       ${fixedTotal}`);
    console.log(`  NET CHANGE:            ${newBrokenTotal > 0 ? "+" : ""}${newBrokenTotal - fixedTotal}\n`);

    if (newBrokenFinds.length > 0) {
        console.log(`  NEW BROKEN FINDS (module disappeared on Canary):`);
        console.log(`  ${"─".repeat(60)}`);
        for (const p of newBrokenFinds) {
            const findStr = p.find.length > 80 ? p.find.substring(0, 80) + "..." : p.find;
            console.log(`  ${p.plugin}:${p.line}  find: "${findStr}"`);
        }
        console.log();
    }

    if (newBrokenMatches.length > 0) {
        console.log(`  NEW BROKEN MATCHES (module exists but pattern broke on Canary):`);
        console.log(`  ${"─".repeat(60)}`);
        for (const p of newBrokenMatches) {
            const findStr = p.find.length > 80 ? p.find.substring(0, 80) + "..." : p.find;
            console.log(`  ${p.plugin}:${p.line}  find: "${findStr}"`);
            for (const r of (p.brokenReplacements || [])) {
                const ms = r.match.length > 60 ? r.match.substring(0, 60) + "..." : r.match;
                console.log(`    broken match: /${ms}/${r.error ? ` (${r.error})` : ""}`);
            }
        }
        console.log();
    }

    if (fixedPatches.length > 0) {
        console.log(`  FIXED ON CANARY (broken on Stable, working on Canary):`);
        console.log(`  ${"─".repeat(60)}`);
        for (const p of fixedPatches) {
            console.log(`  ${p.plugin}:${p.line}`);
        }
        console.log();
    }

    console.log(`${"=".repeat(70)}`);
    if (newBrokenTotal === 0) {
        console.log("  VERDICT: NO NEW BREAKS -- Safe to update Discord Stable");
    } else {
        console.log(`  VERDICT: ${newBrokenTotal} NEW BREAK${newBrokenTotal !== 1 ? "S" : ""} on Canary -- FIX BEFORE updating Stable`);
    }
    console.log(`${"=".repeat(70)}\n`);

    return newBrokenTotal;
}

async function runCompareMode() {
    if (!JSON_OUTPUT) console.log("Running compare mode: Stable vs Canary\n");

    // Extract patches once (same for both channels)
    const patches = extractAllPatches("1/4");

    // Download and validate both channels
    if (!JSON_OUTPUT) console.log("\n--- STABLE ---");
    const stable = await downloadAndExtractModules("stable", "[2/4] ");
    const stableResults = validatePatches(stable.modules, patches, stable.buildInfo.buildNumber);
    const stableReport = buildReportObject(stableResults, stable.buildInfo);

    if (!JSON_OUTPUT) console.log("\n--- CANARY ---");
    const canary = await downloadAndExtractModules("canary", "[3/4] ");
    const canaryResults = validatePatches(canary.modules, patches, canary.buildInfo.buildNumber);
    const canaryReport = buildReportObject(canaryResults, canary.buildInfo);

    // Build sets of broken patch keys for each channel
    const stableBrokenKeys = new Set([
        ...stableReport.broken_finds.map(patchKey),
        ...stableReport.broken_matches.map(patchKey),
    ]);
    const canaryBrokenKeys = new Set([
        ...canaryReport.broken_finds.map(patchKey),
        ...canaryReport.broken_matches.map(patchKey),
    ]);

    // NEW breaks: broken on Canary but NOT broken on Stable
    const newBrokenFinds = canaryReport.broken_finds.filter(p => !stableBrokenKeys.has(patchKey(p)));
    const newBrokenMatches = canaryReport.broken_matches.filter(p => !stableBrokenKeys.has(patchKey(p)));

    // FIXED: broken on Stable but NOT broken on Canary
    const fixedPatches = [
        ...stableReport.broken_finds.filter(p => !canaryBrokenKeys.has(patchKey(p))),
        ...stableReport.broken_matches.filter(p => !canaryBrokenKeys.has(patchKey(p))),
    ];

    if (JSON_OUTPUT) {
        const output = {
            timestamp: new Date().toISOString(),
            mode: "compare",
            stable: stableReport,
            canary: canaryReport,
            diff: {
                new_broken_finds: newBrokenFinds,
                new_broken_matches: newBrokenMatches,
                fixed: fixedPatches,
                new_broken_total: newBrokenFinds.length + newBrokenMatches.length,
                fixed_total: fixedPatches.length,
                net_change: (newBrokenFinds.length + newBrokenMatches.length) - fixedPatches.length,
            },
        };
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
        process.exit(output.diff.new_broken_total > 0 ? 1 : 0);
    }

    // Save individual reports
    const stableReportPath = join(CACHE_DIR, `report_stable_${stable.buildInfo.buildNumber}.json`);
    writeFileSync(stableReportPath, JSON.stringify(stableReport, null, 2));

    const canaryReportPath = join(CACHE_DIR, `report_canary_${canary.buildInfo.buildNumber}.json`);
    writeFileSync(canaryReportPath, JSON.stringify(canaryReport, null, 2));

    // Save comparison report
    const comparePath = join(CACHE_DIR, `compare_${stable.buildInfo.buildNumber}_vs_${canary.buildInfo.buildNumber}.json`);
    writeFileSync(comparePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        stable: { buildNumber: stable.buildInfo.buildNumber, versionHash: stable.buildInfo.versionHash },
        canary: { buildNumber: canary.buildInfo.buildNumber, versionHash: canary.buildInfo.versionHash },
        diff: {
            new_broken_finds: newBrokenFinds,
            new_broken_matches: newBrokenMatches,
            fixed: fixedPatches,
        },
    }, null, 2));

    // Print comparison report
    if (!JSON_OUTPUT) {
        console.log(`\n[4/4] Comparing results...`);
    }
    const newBroken = printCompareReport(stableReport, canaryReport, newBrokenFinds, newBrokenMatches, fixedPatches);

    console.log(`Reports saved to:`);
    console.log(`  ${stableReportPath}`);
    console.log(`  ${canaryReportPath}`);
    console.log(`  ${comparePath}`);

    process.exit(newBroken > 0 ? 1 : 0);
}

// ============================================================
// Single-channel mode
// ============================================================

async function runSingleMode() {
    const { buildInfo, modules } = await downloadAndExtractModules(CHANNEL, `[${COMPARE_MODE ? "" : ""}] `);

    const patches = extractAllPatches("3.5/5");
    const results = validatePatches(modules, patches, buildInfo.buildNumber);

    const report = buildReportObject(results, buildInfo);

    if (JSON_OUTPUT) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        const broken = report.summary.broken_find + report.summary.broken_match;
        process.exit(broken > 0 ? 1 : 0);
    }

    const broken = printReport(results, buildInfo);

    // Save JSON report
    const reportPath = join(CACHE_DIR, `report_${CHANNEL}_${buildInfo.buildNumber}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report saved to: ${reportPath}`);

    process.exit(broken > 0 ? 1 : 0);
}

// ============================================================
// Main
// ============================================================

async function main() {
    try {
        if (COMPARE_MODE) {
            await runCompareMode();
        } else {
            await runSingleMode();
        }
    } catch (e) {
        console.error(`\nFATAL: ${e.message}`);
        if (VERBOSE) console.error(e.stack);
        process.exit(2);
    }
}

main();
