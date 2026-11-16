/*
 * MCP 서버가 런타임에 네트워크 없이 쓰는 정적 데이터(src/data.ts)를 생성한다.
 * 원천은 네 곳 — 포털 src/site.ts(PROJECTS 제품 카탈로그) · 형제 레포 unikit-ui의
 * packages/unikit/registry.json(카탈로그) · shadcn/registry의 loadRegistryItem
 * (아이템별 files[].content 포함 전문 — ui.ll3.kr/r/<name>.json과 동일 로직) ·
 * 각 제품 루트 llms.txt. scriptca·rustra는 llms.txt가 없어도 docsAvailable:false로
 * 통과(준비되면 재실행 시 자동 포함). bun run sync:data로 재생성.
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
 * shadcn/registry loadRegistryItem · 각 제품 루트 llms.txt
 */
export const SERVER_VERSION = ${JSON.stringify(pkg.version)};
export const SITE_ORIGIN = "https://ui.ll3.kr";
export const PRODUCTS_JSON = ${JSON.stringify(JSON.stringify(products))};
export const CATALOG_JSON = ${JSON.stringify(JSON.stringify(catalog))};
export const ITEMS_JSON = ${JSON.stringify(JSON.stringify(entries))};
export const DOCS_JSON = ${JSON.stringify(JSON.stringify(docs))};
`;
  writeFileSync(OUT, out, "utf8");

  const names = Object.keys(entries).length;
  const docsList = Object.keys(docs).join(", ") || "없음";
  const kb = (out.length / 1024).toFixed(1);
  console.log(
    `src/data.ts 생성 완료 — 아이템 ${names}종 · 제품 문서 ${docsList} · ${kb} KiB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
