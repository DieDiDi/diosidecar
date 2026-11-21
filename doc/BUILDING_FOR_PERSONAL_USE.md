# Build and release DioSidecar

## Build from source

Use Node.js 26 LTS for the same development environment as CI. From a Git checkout, initialize the pinned editor if needed. Release source archives already contain the editor.

```sh
git submodule update --init --recursive
npm run setup
npm run typecheck:agent
npm test
npm start
```

The Agent build creates `agent/dist/`, writes the sidebar bundle into the `drawio` submodule and appends a loader to `drawio/src/main/webapp/js/PostConfig.js`. The edited submodule worktree is expected after a build. Review changes to the recorded submodule commit separately when updating upstream.

For a local Apple Silicon `.app` build, run `npm run package:mac`. For `.dmg` and `.zip` previews, run `npm run release:mac:arm64`. Files are written to `dist/`. Build scripts for Windows, Linux and Intel macOS are available for local testing. The first automated release targets Apple Silicon.

## Validate a preview

1. Run the **Build macOS preview** workflow manually from the Actions tab. It uploads artifacts for inspection.
2. Download the macOS preview and corresponding source archive. Verify that the source archive can run `npm run setup` after extracting it.
3. Open the app with a clean test profile or on a separate test account. Open the Agent sidebar, connect a test backend, edit a sample diagram, undo once, save and reopen. Check that two open documents keep their edits separate.
4. Check the signing status before distribution. The current automation produces a preview without a Developer ID signature or notarization. Use an Apple Developer ID certificate and notarization for ordinary public installer distribution. Source builds are available while installer signing is pending.

## Create a release

For version `0.1.0`, push tag `v0.1.0` from the tested release commit. The tag must match `package.json`. The workflow assembles a draft prerelease with the checked installer files, source archive and `SHA256SUMS.txt`. The source archive includes the pinned editor, build scripts and third-party notices. Review the draft and describe the platforms and agents you tested before publishing.
