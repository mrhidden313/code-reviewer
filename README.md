# Local AI Code Reviewer

An intelligent, context-aware code analysis extension for Visual Studio Code powered by Google Gemini.

[![Download VSIX](https://img.shields.io/badge/Download-VSIX%20Extension-2ea44f?style=for-the-badge)](https://github.com/mrhidden313/code-reviewer/raw/main/local-robin-reviewer-0.0.1.vsix)

## Direct Download

Click the link below to download the ready-to-install compiled `.vsix` package:

- **[Download local-robin-reviewer-0.0.1.vsix](https://github.com/mrhidden313/code-reviewer/raw/main/local-robin-reviewer-0.0.1.vsix)**

## Overview

Local AI Code Reviewer inspects local Git changes directly inside your editor. It analyzes code diffs, reads related project files for context, and identifies runtime bugs, logic defects, and security vulnerabilities without cluttering your workflow with formatting noise.

## Core Capabilities

- **Automated Defect Analysis:** Flags runtime exceptions, concurrency hazards, resource leaks, and unhandled promises.
- **Context-Aware Tooling:** Inspects callers and type definitions across the workspace before generating recommendations.
- **Interactive Review Threads:** Displays findings as native editor gutter comment threads with one-click `Apply Fix` and `Dismiss` actions.
- **Integrated Sidebar Chat:** Conversational workspace assistant capable of inspecting any project file or triggering targeted reviews.
- **Nested Repository Discovery:** Detects active Git repositories across monorepos and subdirectories.

## Installation

1. Download `local-robin-reviewer-0.0.1.vsix` using the download link above.
2. In VS Code, navigate to Extensions (`Ctrl+Shift+X`).
3. Select the menu icon (`...`) and choose **Install from VSIX...**.
4. Select the downloaded file.

## Settings

Configure via VS Code Settings (`Ctrl+,` -> search `localRobin`):

- `localRobin.geminiApiKey`: Google Gemini API key.
- `localRobin.model`: Model name (default: `gemini-2.5-flash`).
- `localRobin.baseUrl`: API base URL (default: `https://generativelanguage.googleapis.com`).
- `localRobin.maxTurns`: Maximum agent exploration turns (default: `5`).

## Commands

- `Local Robin: Review Uncommitted Changes`: Runs analysis on modified files.
- `Local Robin: Clear All Review Comments`: Removes active review threads.
- `Refresh Findings`: Updates the sidebar findings list.

## License

MIT
