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

1. In the Actions tab, choose **Build macOS preview** or **Build Windows preview**, then click **Run workflow**.
2. Once the run succeeds, download its **Artifacts**. The Windows artifact `diosidecar-windows-x64-preview` includes the installer and ZIP. The macOS artifact also includes a corresponding source archive that can be built with `npm run setup` after extracting it.
3. Open the app with a clean test profile or on a separate test account. Open the Agent sidebar, connect a test backend, edit a sample diagram, undo once, save and reopen. Check that two open documents keep their edits separate.
4. Check the signing status before distribution. The preview workflows produce unsigned installers. For macOS distribution, use an Apple Developer ID certificate and notarization.

## Create a release

For version `0.1.0`, push tag `v0.1.0` from the tested release commit. The tag must match `package.json`. The macOS workflow assembles a draft prerelease with the installer files, source archive and `SHA256SUMS.txt`. The source archive includes the pinned editor, build scripts and third-party notices. Review the draft and describe the platforms and agents you tested before publishing.
