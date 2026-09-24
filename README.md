# OpenFox Headroom Plugin

Native context compression plugin for [OpenFox](https://github.com/co-l/openfox) using [Headroom](https://github.com/headroomlabs-ai/headroom).

## Features

- **Context Compression Pipeline**: Automatically compresses prompt messages and tool outputs before dispatching to the LLM via `POST /v1/compress`.
- **Prompt Cache Protection**: Configure `frozenMessageCount` to keep initial conversation messages unmodified for optimal prefix caching.
- **Fail-Open Resilience**: If the Headroom proxy is stopped or unreachable, OpenFox transparently falls back to uncompressed messages without interrupting turns.
- **Dashboard Modal**: Header action button to quickly open the Headroom Dashboard (`http://127.0.0.1:8787/dashboard`) in an iframe modal.
- **Settings Integration**: Configure proxy URL, token budget, and toggle compression directly in OpenFox settings.

## Installation

Install via **Settings → Plugins** in OpenFox with:
- Local path: `tmp/openfox-plugins/openfox-headroom`
- Or package name: `openfox-headroom`
