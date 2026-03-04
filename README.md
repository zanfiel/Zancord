# Zancord

A custom Discord client mod forked from [Equicord](https://github.com/Equicord/Equicord) / [Vencord](https://github.com/Vendicated/Vencord), with 300+ plugins, a synthwave cyberpunk theme, and a remote plugin system.

## Features

- **300+ built-in plugins** from Vencord and Equicord
- **Synthwave cyberpunk theme** (ZancordTheme plugin)
- **Remote plugin system** with manifest-based registry, SHA-256 integrity verification, and runtime loading
- **Custom branding** throughout the UI

## Installing (Dev Build)

### Prerequisites

- [Git](https://git-scm.com/download)
- [Node.JS LTS](https://nodejs.dev/en/)
- pnpm: `npm i -g pnpm`

### Setup

```shell
git clone https://github.com/zanfiel/Zancord
cd Zancord
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

### Build for web

```shell
pnpm buildWeb
```

## Remote Plugin System

Zancord includes a manifest-based remote plugin system. Plugins are fetched from a manifest URL, verified with SHA-256 hashes, and loaded at runtime.

- Settings > Remote Plugins tab to browse, install, and manage
- Plugin bundles evaluated via Function() constructor
- CSS injection supported
- No patch support (patches require compile-time webpack bundling)

See `remote-plugins/` for manifest format and sample plugin.

## Credits

- [Vendicated](https://github.com/Vendicated) for [Vencord](https://github.com/Vendicated/Vencord)
- [Equicord](https://github.com/Equicord/Equicord) team
- [verticalsync](https://github.com/verticalsync) for [Suncord](https://github.com/verticalsync/Suncord)

## Disclaimer

Discord is a trademark of Discord Inc. Client modifications are against Discord's Terms of Service. Use at your own risk.
