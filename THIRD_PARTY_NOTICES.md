# Third-party notices

DioSidecar is an independent project based on draw.io Desktop. The desktop host and the project's own contributions are distributed under the [GNU GPL v3](LICENSE). The sources listed below retain their original copyright and license notices. The GPLv3 and AGPLv3 portions are combined under section 13 of the [GPLv3](LICENSE) and [AGPLv3](LICENSES/AGPL-3.0-or-later.txt).

## drawio-desktop

- **Source** [jgraph/drawio-desktop v32.7.4](https://github.com/jgraph/drawio-desktop/tree/5e8406789216bed8f043bc503f4927b4034d7a71)
- **License** [GPL-3.0-only](LICENSE)
- **Copyright** draw.io Ltd (formerly JGraph Ltd) and draw.io AG, as identified in the upstream project and sources.
- **Reuse** Electron desktop host, tests and packaging hooks. DioSidecar modified the main process, preload bridge, update behavior, app branding and packaging configuration.

## drawio

- **Source** [jgraph/drawio v32.7.4](https://github.com/jgraph/drawio/tree/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34), pinned as a Git submodule.
- **License** [Apache-2.0](drawio/LICENSE) for editor source. See the [upstream README](drawio/README.md) and [stencil terms](drawio/src/main/webapp/stencils/LICENSE) for separate terms that apply to shape libraries, icon sets and templates. Those terms include restrictions on redistribution for Atlassian products and the Atlassian ecosystem.
- **Copyright** draw.io Ltd and draw.io AG. Third-party artwork retains its original notices.
- **Reuse** Editor, graph engine, stencils and the ELK bundle. The build appends a load hook to `drawio/src/main/webapp/js/PostConfig.js` and writes the DioSidecar sidebar bundle into `drawio/src/main/webapp/plugins/`.

## Zotero Agent plugin

- **Source** [`54yyyu/zotero-mcp/plugin` at `71df195`](https://github.com/54yyyu/zotero-mcp/tree/71df195e77f83a035a5379fec946bd4b0b41c38e/plugin)
- **License** [AGPL-3.0-or-later](LICENSES/AGPL-3.0-or-later.txt), as declared by the plugin. The upstream MCP server and CLI are separately licensed.
- **Copyright** the Zotero Agent plugin authors and contributors.
- **Reuse** The ACP runtime, shared types, translations and sidebar in `agent/core/` came from `plugin/src/`. `agent/main/store.ts` was adapted from `plugin/src/zotero/store.ts`, and `agent/build.mjs` was adapted from `plugin/scripts/build.mjs`.

## drawio-mcp

- **Source** [jgraph/drawio-mcp at `9bd19b3`](https://github.com/jgraph/drawio-mcp/tree/9bd19b362038593bc8611d426c92cd62dc222302)
- **License** [Apache-2.0](LICENSES/Apache-2.0.txt) for source and documentation, subject to upstream notices for third-party materials.
- **Copyright** draw.io Ltd and draw.io AG. See the upstream project for license and attribution information.
- **Reuse** XML and shape helpers in `agent/shared/`, the canvas server and ELK integration in `agent/mcp/`, and the Mermaid, style and XML references in `agent/skills/`. The bundled search index is copied from `shape-search/search-index.json`.
