# @unikit-bridge/mcp

MCP server for the [unikit-bridge](https://unikit.ll3.kr) family — starting with [UniKit UI](https://ui.ll3.kr), the component registry where **one source renders on both React (web) and React Native**.

The server bundles its data at build time — the UniKit UI registry snapshot (71 items: full sources plus theme tokens & CSS) and per-product `llms.txt` docs — so it runs with **zero network access**. Data refreshes with each npm release. It lives in the family portal repo ([`loopy-lim/unikit`](https://github.com/loopy-lim/unikit), `packages/mcp`) so it can serve every sibling product, not just the UI.

## Tools

| Tool | What it does |
|---|---|
| `search_items` | Search UniKit UI registry items by name/title/description (empty query lists all 71) |
| `view_item` | Full item payload — metadata, dependencies, complete source (`files[].content`), and theme `cssVars` / style CSS |
| `get_install_command` | Install commands in both modes: npm package deps and shadcn CLI source copy |
| `get_docs` | Product docs (`llms.txt`). No argument → family overview; `{"product":"unikit-ui"}` → full token rules, entrypoints, known limitations. Read before writing components |

## Setup

Claude Code:

```sh
claude mcp add unikit-bridge -- npx -y @unikit-bridge/mcp
```

Other MCP clients: run `npx -y @unikit-bridge/mcp` as a stdio server.

## Regenerate bundled data

The sync reads sibling checkouts, so run it on a machine with the family repos side by side (`.../ll3/{unikit,unikit-ui,scriptca,rustra}`). CI never regenerates — it typechecks the committed `src/data.ts` only:

```sh
cd packages/mcp && bun run sync:data
```

Sources: portal `src/site.ts` (`PROJECTS`), the sibling `unikit-ui` repo (`registry.json` + `shadcn/registry` `loadRegistryItem` — the same data as `https://ui.ll3.kr/r/<name>.json`), and each product root `llms.txt`. Products without an `llms.txt` yet (`scriptca`, `rustra`) are listed with `docsAvailable: false`; writing their `llms.txt` and re-running the sync picks them up automatically.
