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

For a local Apple Silicon `.app` build, run `npm run package:mac`. Use `npm run release:mac:arm64` for a macOS `.dmg` and `.zip`, or run `npm run release:win` on Windows to build an x64 `.exe` installer and a `.zip` archive. Files are written to `dist/`.

## Validate a preview

1. In the Actions tab, choose **Release**, then click **Run workflow**. Leave the tag blank to use the version in `package.json`. A successful run also prepares a draft prerelease.
2. Download the run's `diosidecar-macos-arm64` and `diosidecar-windows-x64` artifacts. The macOS artifact includes the corresponding source archive. To repeat the macOS launch and quit check locally, run `node .github/scripts/smoke-mac.mjs <macOS zip path> <version>` from the repository.
3. Open the app with a clean test profile or on a separate test account. Open the Agent sidebar, connect a test backend, edit a sample diagram, undo once, save and reopen. Check that two open documents keep their edits separate, then quit the app from its menu.
4. Check the signing status before distribution. The release workflow produces preview installers without a distribution signature. For macOS distribution, use an Apple Developer ID certificate and notarization.

## Create a release

Push a `v<version>` tag from the tested release commit. The version must match `package.json`. The Release workflow assembles a draft prerelease with the macOS and Windows installers, source archive and `SHA256SUMS.txt`. The source archive includes the pinned editor, build scripts and third-party notices. Review the draft and describe the platforms and agents you tested before publishing.
