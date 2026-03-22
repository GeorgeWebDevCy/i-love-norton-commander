# I Love Norton Commander

A Tauri desktop app that recreates the dual-pane file-manager feel of Norton Commander with a modern TypeScript frontend and native filesystem commands.

## Current Features

- Dual-pane directory browsing with drive selection
- Keyboard-first navigation with `Tab`, `Enter`, `Backspace`, and `F5` through `F9`
- Sorting by name, extension, size, or modified date
- File and folder operations: copy, move, rename, delete, and create directory
- Tools modal for quick actions like swapping panes, revealing selections, and copying paths
- Install modal with local setup and build guidance for the Tauri toolchain

## Local Setup

1. Install Node.js and npm.
2. Install Rust so `cargo` is available in your shell.
3. On Windows, install the Visual Studio C++ build tools required by Tauri.

Then run:

```sh
npm install
npm run check
npm run tauri dev
```

To build distributables:

```sh
npm run tauri build
```

## Notes

- The frontend can be type-checked with `npm run check`.
- Native Tauri builds require a working Rust toolchain and platform prerequisites.
