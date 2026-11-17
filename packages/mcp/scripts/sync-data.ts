/*
 * MCP 서버가 런타임에 네트워크 없이 쓰는 정적 데이터(src/data.ts)를 생성한다.
 * 원천은 다섯 곳 — 포털 src/site.ts(PROJECTS 제품 카탈로그) · 형제 레포 unikit-ui의
 * packages/unikit/registry.json(카탈로그) · shadcn/registry의 loadRegistryItem
 * (아이템별 files[].content 포함 전문 — ui.ll3.kr/r/<name>.json과 동일 로직) ·
 * 각 제품 루트 llms.txt(세 제품 전부 동봉) · unikit-ui docs/components.md
 * (컴포넌트별 사용법 조각으로 쪼개 동봉 — view_item이 해당 아이템 분량만 전달).
 * llms.txt가 없는 제품은
 * docsAvailable:false로 통과하므로 새 제품은 문서를 쓰고 재실행하면 자동 포함.
 * bun run sync:data로 재생성.
 * 형제 레포가 있는 로컬에서만 돌며, CI는 커밋된 data.ts만 검증한다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRegistry,
  loadRegistryItem,
  type LoadRegistryOptions,
} from "shadcn/registry";

import { PROJECTS } from "../../../src/site";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const LL3_ROOT = path.resolve(PORTAL_ROOT, "..");
const OUT = path.resolve(SCRIPT_DIR, "..", "src", "data.ts");

/** 제품 id(site.ts) → 로컬 형제 레포 디렉터리 이름 */
const REPO_DIRS: Record<string, string> = {
  ui: "unikit-ui",
  scriptca: "scriptca",
  rustra: "rustra",
};

/** ui.ll3.kr/r/<name>.json 과 같은 원천에서 아이템을 로드한다 */
const options: LoadRegistryOptions = {
  cwd: path.join(LL3_ROOT, "unikit-ui", "packages", "unikit"),
};

/**
 * docs/components.md를 이름→사용법 조각으로 쪼갠다.
 * 전용 섹션이 있는 컴포넌트(Button 등·EditorToolbar)는 섹션 전문,
 * 배치 표 컴포넌트는 표 행을 "컴포넌트 — 요점" 한 줄로. 표 행 패턴에 우연히
 * 맞아떨어지는 다른 표의 행(Props 표 등)은 레지스트리 이름이 아니면 조회될 일이
 * 없으므로 그대로 둔다.
 */
function parseComponentUsage(markdown: string): Record<string, string> {
  const fullSections: Record<string, string> = {
    Button: "button",
    Card: "card",
    Input: "input",
    Label: "label",
    Badge: "badge",
  };
  const usage: Record<string, string> = {};
  let section: { name: string; body: string[] } | null = null;
  const closeSection = () => {
    if (section) {
      const body = section.body.join("\n").trim();
      if (body) usage[section.name] = body;
      section = null;
    }
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      closeSection();
      const title = line.slice(3).trim();
      if (fullSections[title]) {
        section = { name: fullSections[title], body: [] };
      } else if (title.includes("EditorToolbar")) {
        section = { name: "editor-toolbar", body: [] };
      }
      continue;
    }
    if (section) {
      section.body.push(line);
      continue;
    }
    const row = /^\| `([a-z0-9-]+)` \| (.+) \|$/.exec(line);
    if (row) {
      const split = row[2].indexOf(" | ");
      if (split > 0) {
        usage[row[1]] = `${row[2].slice(0, split)} — ${row[2].slice(split + 3)}`;
      }
    }
  }
  closeSection();
  return usage;
}

async function main() {
  const catalog = await loadRegistry(options);
  const entries: Record<string, unknown> = {};
  for (const item of catalog.items ?? []) {
    entries[item.name] = await loadRegistryItem(item.name, options);
  }

  const pkg = JSON.parse(
    readFileSync(path.join(SCRIPT_DIR, "..", "package.json"), "utf8"),
  ) as { version: string };

  const products: unknown[] = [];
  const docs: Record<string, string> = {};
  const usagePath = path.join(LL3_ROOT, "unikit-ui", "docs", "components.md");
  const usage = parseComponentUsage(readFileSync(usagePath, "utf8"));
  for (const project of PROJECTS) {
    const llmsPath = REPO_DIRS[project.id]
      ? path.join(LL3_ROOT, REPO_DIRS[project.id], "llms.txt")
      : "";
    const available = Boolean(llmsPath) && existsSync(llmsPath);
    products.push({
      id: project.id,
      name: project.name,
      tagline: project.tagline,
      site: project.site,
      repo: `https://github.com/${project.repo}`,
      packages: project.packages.map((ref) => ({
        name: ref.name,
        registry: ref.registry,
      })),
      docsAvailable: available,
    });
    if (available) {
      docs[project.id] = readFileSync(llmsPath, "utf8");
    }
  }

  const out = `/*
 * MCP 정적 데이터 — bun run sync:data로 재생성(직접 편집 금지).
 * 원천: 포털 src/site.ts(PROJECTS) · 형제 unikit-ui 레포 registry.json +
 * shadcn/registry loadRegistryItem · 각 제품 루트 llms.txt ·
 * unikit-ui docs/components.md(컴포넌트별 사용법)
 */
export const SERVER_VERSION = ${JSON.stringify(pkg.version)};
export const SITE_ORIGIN = "https://ui.ll3.kr";
export const PRODUCTS_JSON = ${JSON.stringify(JSON.stringify(products))};
export const CATALOG_JSON = ${JSON.stringify(JSON.stringify(catalog))};
export const ITEMS_JSON = ${JSON.stringify(JSON.stringify(entries))};
export const DOCS_JSON = ${JSON.stringify(JSON.stringify(docs))};
export const USAGE_JSON = ${JSON.stringify(JSON.stringify(usage))};
`;
  writeFileSync(OUT, out, "utf8");

  const names = Object.keys(entries).length;
  const docsList = Object.keys(docs).join(", ") || "없음";
  const kb = (out.length / 1024).toFixed(1);
  console.log(
    `src/data.ts 생성 완료 — 아이템 ${names}종 · 제품 문서 ${docsList} · 사용법 ${Object.keys(usage).length}종 · ${kb} KiB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
