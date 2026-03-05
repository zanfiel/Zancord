/*
 * Zancord, a Discord client mod
 * Copyright (c) 2026 Zan and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { extname, normalize } from "path";

const MIME_MAP: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
};

/**
 * Read a local image file and return it as a base64 data URI.
 * Runs in the main process (Node.js) via IPC.
 */
export async function readImageFile(_: Electron.IpcMainInvokeEvent, filePath: string): Promise<string | null> {
    try {
        const normalized = normalize(filePath);

        if (!existsSync(normalized)) {
            console.error("[ZancordTheme native] File not found:", normalized);
            return null;
        }

        const ext = extname(normalized).toLowerCase();
        const mime = MIME_MAP[ext] ?? "image/jpeg";

        const buffer = await readFile(normalized);
        const base64 = buffer.toString("base64");

        console.log("[ZancordTheme native] Read image:", normalized, `(${buffer.length} bytes, ${mime})`);
        return `data:${mime};base64,${base64}`;
    } catch (e) {
        console.error("[ZancordTheme native] Failed to read image:", e);
        return null;
    }
}
